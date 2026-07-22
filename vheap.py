import argparse
from typing import Any, Dict, List, Optional
from collections import defaultdict
from pathlib import Path
import inspect
from aiohttp import web
import threading
import asyncio
import socketio
import json
import os

# pwndbg command implementation #
import gdb
import pwndbg.commands
import pwndbg.aglib.heap
import pwndbg.libc
from pwndbg.commands import CommandCategory
from pwndbg.aglib.heap.ptmalloc import (
    Bins,
    Chunk,
    GlibcMemoryAllocator,
)

try:
    import pwndbg.glibc as pwndbg_glibc
except ModuleNotFoundError:
    import pwndbg.libc.glibc as pwndbg_glibc


def check_safe_linking() -> bool:
    try:
        return pwndbg_glibc.check_safe_linking(pwndbg.libc.version())
    except TypeError:
        return pwndbg_glibc.check_safe_linking()


MODULE_DIR = Path(inspect.getsourcefile(inspect.currentframe()) or __file__).resolve().parent

# The visualizer is commonly used with 64-bit glibc, but deriving these values
# from GDB keeps the data view useful for other target architectures as well.
DEFAULT_DATA_BYTES = 64
MAX_DATA_BYTES = 0x10000
MAX_MEMORY_VIEW_BYTES = 0x10000
MEMORY_VIEW_TIMEOUT = 3.0
MAX_STRUCTURE_FIELDS = 96
POINTER_FIELDS = {
    "ar_ptr",
    "prev",
    "next",
    "next_free",
    "top",
    "last_remainder",
    "fd",
    "bk",
    "fd_nextsize",
    "bk_nextsize",
    "fastbinsY",
    "bins",
    "entries",
    "sbrk_base",
}


def _safe_attr(obj: Any, name: str) -> Any:
    """Read an optional Pwndbg property without making collection brittle."""
    try:
        value = getattr(obj, name)
    except Exception:
        return None

    if callable(value):
        try:
            value = value()
        except TypeError:
            return None
        except Exception:
            return None
    return value


def _value_to_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        pass

    # Pwndbg wrappers (for example Chunk) generally expose an address rather
    # than implementing __int__.
    address = _safe_attr(value, "address")
    if address is not None and address is not value:
        try:
            return int(address)
        except (TypeError, ValueError, OverflowError):
            pass

    try:
        return int(str(value), 0)
    except (TypeError, ValueError, OverflowError):
        return None


def _parse_address(value: Any) -> Optional[int]:
    """Parse a user-supplied address without accepting negative values."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        raw = str(value).strip()
        if not raw:
            return None
        address = int(raw, 16 if raw.lower().startswith("0x") else 10)
    except (TypeError, ValueError, OverflowError):
        return None
    return address if 0 <= address <= 0xFFFFFFFFFFFFFFFF else None


def _parse_memory_size(value: Any) -> Optional[int]:
    """Keep an arbitrary memory request bounded before it reaches GDB."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        raw = str(value).strip()
        size = int(raw, 16 if raw.lower().startswith("0x") else 10)
    except (TypeError, ValueError, OverflowError):
        return None
    return size if 0 < size <= MAX_MEMORY_VIEW_BYTES else None


def _format_value(value: Any) -> str:
    integer = _value_to_int(value)
    if integer is not None:
        return hex(integer)
    if value is None:
        return "None"
    return str(value)


def _format_flag(value: Any) -> str:
    integer = _value_to_int(value)
    if integer is not None:
        return str(int(integer != 0))
    return str(int(bool(value)))


def _pointer_size() -> int:
    try:
        return int(gdb.lookup_type("void").pointer().sizeof)
    except Exception:
        return 8


def _read_target_memory(address: int, size: int) -> bytes:
    if address is None or size <= 0:
        return b""
    try:
        inferior = gdb.selected_inferior()
        if hasattr(inferior, "is_valid") and not inferior.is_valid():
            return b""
        return bytes(inferior.read_memory(int(address), int(size)))
    except Exception:
        # A stale/corrupted chunk should not prevent all other bins from being
        # displayed. The missing bytes are represented by an empty data list.
        return b""


def _safe_ascii(data: bytes) -> str:
    # Avoid characters that have special meaning in Graphviz HTML labels.
    return "".join(chr(byte) if 32 <= byte < 127 and chr(byte) not in "<>&\"" else "." for byte in data)


def vhadd_allchunks() -> None:
    allocator = pwndbg.aglib.heap.current
    assert isinstance(allocator, GlibcMemoryAllocator)
    main_arena = allocator.main_arena
    if main_arena is None:
        return

    vheap.addBinHead("allchunkshead", "all")

    for i, chunk in enumerate(main_arena.active_heap):
        address = _value_to_int(chunk.address)
        if address is None:
            continue
        data, data_size, data_truncated, data_disabled = vheap.readChunkData(
            address + 2 * _pointer_size(), vheap.chunkPayloadSize(chunk)
        )
        achunk = vheap.makeChunk(
            i,
            address,
            chunk.prev_size,
            chunk.real_size,
            chunk.non_main_arena,
            chunk.is_mmapped,
            chunk.prev_inuse,
            chunk.fd,
            chunk.bk,
            extra_fields=vheap.extraChunkFields(chunk),
            data=data,
            data_address=address + 2 * _pointer_size(),
            data_size=data_size,
            data_truncated=data_truncated,
            data_disabled=data_disabled,
        )

        vheap.addChunkToBin("allchunks", achunk)


def vhadd_bins(bins: Bins, bin_name: str, safe_linking: bool, addr_offset: int = 0) -> None:
    allocator = pwndbg.aglib.heap.current
    assert isinstance(allocator, GlibcMemoryAllocator)

    if bins is not None:
        offset_fd = allocator.chunk_key_offset("fd")
        for bi, size in enumerate(bins.bins):
            if size == "type":
                continue
            thebin = bins.bins[size]
            fd_chain = getattr(thebin, "fd_chain", [])
            if not fd_chain:
                continue
            tbinhead = _value_to_int(fd_chain[0])
            if tbinhead not in (None, 0):
                tbinName = f"{bin_name}head{bi}"
                vheap.addBinHead(tbinName, str(hex(tbinhead)))

                # loop through chunks in the bin
                for i in range(len(fd_chain) - 1):
                    chain_address = _value_to_int(fd_chain[i])
                    if chain_address is None:
                        continue
                    chunk_address = chain_address + addr_offset
                    chunk = Chunk(chunk_address)
                    raw_fd = _value_to_int(chunk.fd)
                    fd = raw_fd ^ ((chunk_address + offset_fd) >> 12 if safe_linking else 0) \
                        if raw_fd is not None else None
                    # tcache chains expose the user pointer while other bins
                    # expose the chunk header address.
                    data_address = chain_address if addr_offset else chunk_address + 2 * _pointer_size()
                    data, data_size, data_truncated, data_disabled = vheap.readChunkData(
                        data_address, vheap.chunkPayloadSize(chunk)
                    )
                    jsonchunk = vheap.makeChunk(
                        i,
                        chain_address,
                        chunk.prev_size,
                        chunk.real_size,
                        chunk.non_main_arena,
                        chunk.is_mmapped,
                        chunk.prev_inuse,
                        fd,
                        chunk.bk,
                        extra_fields=vheap.extraChunkFields(chunk),
                        data=data,
                        data_address=data_address,
                        data_size=data_size,
                        data_truncated=data_truncated,
                        data_disabled=data_disabled,
                    )

                    vheap.addChunkToBin(tbinName.replace("head", ""), jsonchunk)


parser = argparse.ArgumentParser()
parser.description = "Stops vHeap server."


@pwndbg.commands.Command(parser, category=CommandCategory.PTMALLOC2)
def vhstop():
    """
    Stops the vheap server
    """
    vheap.stop()


parser = argparse.ArgumentParser()
parser.description = "Shows the current state of the heap on vHeap page."
parser.add_argument("host", nargs="?", type=str, default="localhost", help="The host to serve.")
parser.add_argument("port", nargs="?", type=int, default=8080, help="The port.")
parser.add_argument("--no-auto-update", action="store_true", help="Don't auto update the heap state on every stop.")
parser.add_argument(
    "--data-bytes",
    type=int,
    default=DEFAULT_DATA_BYTES,
    help="Maximum payload bytes to display per chunk (0 disables payload reads).",
)
parser.add_argument(
    "--no-structures",
    dest="structures",
    action="store_false",
    default=True,
    help="Don't collect ptmalloc management structures.",
)


@pwndbg.commands.Command(parser, category=CommandCategory.PTMALLOC2)
def vhserv(host="localhost", port=8080, no_auto_update=False, data_bytes=DEFAULT_DATA_BYTES, structures=True):
    """
    Generates the json of current heap state and sends to vheap server.
    """
    vheap.configure(data_bytes=data_bytes, show_structures=structures)
    vheap.serve(host, port, not no_auto_update)
    # Update the heap state right away
    if isinstance(pwndbg.aglib.heap.current, GlibcMemoryAllocator):
        vhstate()


parser = argparse.ArgumentParser()
parser.description = "Updates the vHeap view."
parser.add_argument(
    "--data-bytes",
    type=int,
    default=None,
    help="Maximum payload bytes to display per chunk; keeps the current server setting when omitted.",
)
structures_group = parser.add_mutually_exclusive_group()
structures_group.add_argument("--structures", dest="structures", action="store_true", help="Collect ptmalloc management structures.")
structures_group.add_argument("--no-structures", dest="structures", action="store_false", help="Skip ptmalloc management structures.")
parser.set_defaults(structures=None)


@pwndbg.commands.Command(parser, category=CommandCategory.PTMALLOC2)
@pwndbg.commands.OnlyWhenRunning
@pwndbg.commands.OnlyWithResolvedHeapSyms
@pwndbg.commands.OnlyWhenHeapIsInitialized
@pwndbg.commands.OnlyWhenUserspace
def vhstate(data_bytes=None, structures=None):

    vheap.configure(data_bytes=data_bytes, show_structures=structures)
    vheap.state_lock.acquire()
    try:
        vheap.clearHeap()

        allocator = pwndbg.aglib.heap.current
        if not isinstance(allocator, GlibcMemoryAllocator):
            return
        safe_lnk = check_safe_linking()

        vhadd_bins(allocator.tcachebins(None), "tcachebins", safe_lnk, -2 * _pointer_size())
        vhadd_bins(allocator.fastbins(None), "fastbins", safe_lnk)
        vhadd_bins(allocator.unsortedbin(None), "unsortedbin", False)
        vhadd_bins(allocator.smallbins(None), "smallbins", False)
        vhadd_bins(allocator.largebins(None), "largebins", False)

        vhadd_allchunks()
        if vheap.show_structures:
            vheap.collectManagementStructures(allocator)
    finally:
        vheap.state_lock.release()


# end pwndbg commands #


class VisualHeap:
    # Thread loop
    loop: Optional[asyncio.AbstractEventLoop] = None
    # Socket io
    sio: Optional[socketio.AsyncServer] = None
    site: Optional[web.TCPSite] = None
    # To hold status of server
    serving = False
    # To hold bins head addresses
    binsheads: Dict[str, str] = {}
    # To hold bins chunks
    binschunks: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    # ptmalloc management structures (malloc_state, heap_info, tcache, ...)
    structures: List[Dict[str, Any]] = []
    viewPath = MODULE_DIR / "vheapViews"
    # Defaults
    port = 8080
    host = "localhost"
    auto_update = False
    data_bytes = DEFAULT_DATA_BYTES
    show_structures = True

    def __init__(self):
        self.state_lock = threading.RLock()
        self.server_lock = threading.RLock()
        self.starting = False
        self.stopping = False
        self.data_bytes = DEFAULT_DATA_BYTES
        self.show_structures = True
        self.pointer_size = 8
        self.structures = []
        self.clearHeap()
        self.addBinHead("vHeap is ready", "0x200")

    def configure(self, data_bytes: Optional[int] = None, show_structures: Optional[bool] = None) -> None:
        """Update view options without requiring a server restart."""
        with self.state_lock:
            if data_bytes is not None:
                try:
                    self.data_bytes = max(0, min(int(data_bytes), MAX_DATA_BYTES))
                except (TypeError, ValueError):
                    self.data_bytes = DEFAULT_DATA_BYTES
            if show_structures is not None:
                self.show_structures = bool(show_structures)

    def aiohttp_server(self) -> web.AppRunner:
        """
        HTTP server for the compiled Vite application and Socket.IO transport.

        Development uses Vite's proxy, while the installed plugin serves the
        production bundle directly from ``vheapViews/dist``.  Keep the legacy
        page as a fallback so an older checkout can still start the debugger
        command before the frontend is built.
        """
        self.sio = socketio.AsyncServer()
        dist_path = self.viewPath / "dist"
        index_path = dist_path / "index.html"
        no_cache_headers = {
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        }

        async def index(_request: web.Request) -> web.Response:
            page = index_path if index_path.is_file() else self.viewPath / "vheap.html"
            if not page.is_file():
                raise web.HTTPNotFound(text="vHeap frontend has not been built")
            # Edge can retain an old index that points at assets removed by a
            # newer Vite build. Hashed assets may be cached; the entry page may not.
            return web.FileResponse(page, headers=no_cache_headers)

        async def legacy_js(request: web.Request) -> web.Response:
            # Keep the source-checkout fallback page functional while users
            # transition to the compiled TypeScript bundle.
            name = os.path.basename(request.match_info["name"])
            script = self.viewPath / "static" / "js" / name
            if not script.is_file():
                raise web.HTTPNotFound()
            return web.FileResponse(script, headers=no_cache_headers)

        @web.middleware
        async def frontend_cache_control(request: web.Request, handler) -> web.StreamResponse:
            response = await handler(request)
            if request.path.startswith("/assets/"):
                # Do not let Edge keep a removed hashed asset after a rebuild.
                response.headers.update(no_cache_headers)
            return response

        @self.sio.on('getHeap')
        async def getHeap(sid, _msg):
            """
            on getHeap: send heap data to client
            """
            await self.sio.emit("heapData", self.makeHeapData(), to=sid)

        @self.sio.on("readMemory")
        async def readMemory(sid, message):
            """Read an explicitly requested address range on the GDB thread."""
            payload = message if isinstance(message, dict) else {}
            request_id = str(payload.get("requestId") or "")
            address = _parse_address(payload.get("address"))
            size = _parse_memory_size(payload.get("size"))

            def error_result(message_text: str) -> Dict[str, Any]:
                return {
                    "requestId": request_id,
                    "address": payload.get("address"),
                    "type": payload.get("type"),
                    "requestedSize": size or 0,
                    "availableSize": 0,
                    "data": [],
                    "dataTruncated": True,
                    "dataDisabled": False,
                    "error": message_text,
                }

            if address is None:
                await self.sio.emit("memoryData", error_result("invalid address"), to=sid)
                return
            if size is None:
                await self.sio.emit(
                    "memoryData",
                    error_result(f"size must be between 1 and {MAX_MEMORY_VIEW_BYTES} bytes"),
                    to=sid,
                )
                return

            loop = self.loop
            if loop is None or loop.is_closed():
                await self.sio.emit("memoryData", error_result("GDB event loop is unavailable"), to=sid)
                return

            result_future = loop.create_future()

            def finish(result: Dict[str, Any]) -> None:
                if loop.is_closed():
                    return

                def set_result() -> None:
                    if not result_future.done():
                        result_future.set_result(result)

                loop.call_soon_threadsafe(set_result)

            def read_on_gdb_thread() -> None:
                try:
                    finish(self.readMemoryData(address, size))
                except Exception as error:
                    finish(error_result(f"memory read failed: {error}"))

            try:
                post_event = getattr(gdb, "post_event", None)
                if not callable(post_event):
                    raise RuntimeError("GDB post_event is unavailable")
                post_event(read_on_gdb_thread)
                result = await asyncio.wait_for(result_future, timeout=MEMORY_VIEW_TIMEOUT)
            except asyncio.TimeoutError:
                result = error_result("timed out waiting for GDB to read memory")
            except Exception as error:
                result = error_result(f"memory read request failed: {error}")

            result["requestId"] = request_id
            result["type"] = payload.get("type")
            await self.sio.emit("memoryData", result, to=sid)

        # Create http server, and socket io
        app = web.Application(middlewares=[frontend_cache_control])
        self.sio.attach(app)

        # router
        app.router.add_get('/', index)
        app.router.add_get(r'/static/js/{name}', legacy_js)
        # Vite emits content-addressed JavaScript/CSS under ``assets``.  Do
        # not register a missing directory: this keeps the Python plugin
        # usable from a source checkout where the optional build has not run.
        assets_path = dist_path / "assets"
        if assets_path.is_dir():
            app.router.add_static('/assets', assets_path, show_index=False)

        handler = web.AppRunner(app)

        return handler

    def serve_thread(self) -> None:
        """
        Http Server thread runner
        """
        try:
            self.loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self.loop)
            self.loop.run_until_complete(self.apprunner.setup())
            self.site = web.TCPSite(self.apprunner, self.host, self.port)
            self.loop.run_until_complete(self.site.start())
            with self.server_lock:
                self.serving = True
                self.starting = False
            print(f"vHeap is now serving on http://{self.host}:{self.port}")
            self.loop.run_forever()
        except Exception as error:
            print(f"vHeap server failed to start: {error}")
        finally:
            with self.server_lock:
                self.serving = False
                self.starting = False
                self.stopping = False
            if self.auto_update:
                try:
                    gdb.events.stop.disconnect(gdb_stop_handler)
                except Exception:
                    pass
            if self.loop is not None and not self.loop.is_closed():
                self.loop.close()

    def serve(self, host: str = "localhost", port: int = 8080, auto_update: bool = True) -> None:
        """
        Starts serving vHeap thread
        """
        with self.server_lock:
            if self.serving or self.starting:
                return
            self.host = host
            self.port = port
            self.auto_update = auto_update
            self.apprunner = self.aiohttp_server()
            self.starting = True

            t = threading.Thread(target=self.serve_thread, daemon=True)
            t.start()

            if auto_update:
                gdb.events.stop.connect(gdb_stop_handler)

    def stop_threadsafe(self):
        if self.loop is not None and not self.loop.is_closed():
            self.loop.stop()
        self.clearHeap()
        with self.server_lock:
            self.serving = False
            self.starting = False
            self.stopping = False
        print("vHeap server stopped")

    def stop(self) -> None:
        """
        Stops serving vHeap thread
        """
        if (self.serving or self.starting) and self.loop is not None:
            print("Stopping vHeap server")
            with self.server_lock:
                if self.stopping:
                    return
                self.stopping = True

            async def shutdown():
                try:
                    await self.apprunner.cleanup()
                finally:
                    self.loop.call_soon(self.stop_threadsafe)

            asyncio.run_coroutine_threadsafe(shutdown(), self.loop)
            if self.auto_update:
                try:
                    gdb.events.stop.disconnect(gdb_stop_handler)
                except Exception:
                    pass

    def clearHeap(self):
        """
        Clears the heap heads, bins, and management structures.
        """
        with self.state_lock:
            self.binsheads = {}
            self.binschunks = defaultdict(list)
            self.structures = []

    def addBinHead(self, head: str, address: str):
        """
        Adds a bin head to heads dict wtih its value
        """
        with self.state_lock:
            self.binsheads[head] = address

    def addChunkToBin(self, bin: str, chunk: Dict[str, Any]):
        """
        Adds a chunks to a specific bin
        """
        with self.state_lock:
            self.binschunks[bin].append(chunk)

    def addStructure(self, structure: Dict[str, Any]) -> None:
        """Register a management structure for the next JSON snapshot."""
        if not structure:
            return
        with self.state_lock:
            self.structures.append(structure)

    def makeHeapData(self) -> str:
        """
        Combines heads with bins as json text, ready to be sent to client
        """
        # Serialize while holding the same lock used by the GDB collection
        # path. This prevents the browser from seeing a half-built snapshot.
        with self.state_lock:
            ret = {
                "version": 2,
                "pointerSize": self.pointer_size,
                "structuresEnabled": bool(self.show_structures),
                "heads": dict(self.binsheads),
                "bins": {name: list(chunks) for name, chunks in self.binschunks.items()},
                "structures": list(self.structures),
            }
            # Extensions and older pwndbg wrappers can leave a non-JSON value
            # in an optional field. Stringifying that value keeps the complete
            # snapshot (and the allocator structures panel) available.
            return json.dumps(ret, default=str)

    def chunkPayloadSize(self, chunk: Any) -> int:
        """Return the payload capacity represented by a Pwndbg Chunk."""
        real_size = _value_to_int(_safe_attr(chunk, "real_size"))
        if real_size is None:
            return 0
        # real_size includes the two-word malloc chunk header. The low bits
        # are allocator flags and are not part of the size.
        real_size &= ~0x7
        return max(0, real_size - 2 * _pointer_size())

    def readChunkData(self, address: int, available_size: int):
        """Read a bounded payload and return rows suitable for the frontend."""
        available_size = max(0, int(available_size or 0))
        limit = min(available_size, max(0, int(self.data_bytes)))
        disabled = self.data_bytes == 0
        if disabled or limit == 0:
            return [], available_size, False, disabled

        raw = _read_target_memory(address, limit)
        rows = self._memoryRows(address, raw, _pointer_size())
        return rows, available_size, len(raw) < available_size, disabled

    def _memoryRows(self, address: int, raw: bytes, pointer_size: int) -> List[Dict[str, str]]:
        """Convert raw target bytes to the snapshot row format."""
        word_size = pointer_size if pointer_size in (4, 8) else 8
        rows: List[Dict[str, str]] = []
        for offset in range(0, len(raw), word_size):
            part = raw[offset : offset + word_size]
            rows.append(
                {
                    "offset": hex(offset),
                    "address": hex(int(address) + offset),
                    "value": hex(int.from_bytes(part, byteorder="little", signed=False)),
                    "bytes": part.hex(),
                    "ascii": _safe_ascii(part),
                }
            )
        return rows

    def readMemoryData(self, address: int, size: int) -> Dict[str, Any]:
        """Read an explicit address range for a user-created memory view.

        This method must run on GDB's thread. The Socket.IO handler schedules
        it with ``gdb.post_event`` before serializing the result.
        """
        pointer_size = _pointer_size()
        if pointer_size not in (4, 8):
            pointer_size = 8
        raw = _read_target_memory(address, size)
        return {
            "address": _format_value(address),
            "pointerSize": pointer_size,
            "requestedSize": size,
            "availableSize": len(raw),
            "data": self._memoryRows(address, raw, pointer_size),
            "dataTruncated": len(raw) < size,
            "dataDisabled": False,
            **({"error": "unable to read target memory"} if not raw else {}),
        }

    def extraChunkFields(self, chunk: Any) -> Dict[str, Any]:
        """Collect optional malloc_chunk links exposed by the active Pwndbg."""
        fields: Dict[str, Any] = {}
        for name in ("fd_nextsize", "bk_nextsize"):
            value = _safe_attr(chunk, name)
            if value is not None:
                fields[name] = value
        return fields

    def makeChunk(
        self,
        index: int,
        address: int,
        prevSize: Optional[int],
        chunkSize: Optional[int],
        a: bool,
        m: bool,
        p: bool,
        fd: Optional[int],
        bk: Optional[int],
        extra_fields: Optional[Dict[str, Any]] = None,
        data: Optional[List[Dict[str, str]]] = None,
        data_address: Optional[int] = None,
        data_size: Optional[int] = None,
        data_truncated: bool = False,
        data_disabled: bool = False,
    ) -> Dict[str, Any]:
        """
        Makes a chunk struct
        """
        pointer_size = _pointer_size()
        if pointer_size not in (4, 8):
            pointer_size = 8
        self.pointer_size = pointer_size
        fields: List[Dict[str, str]] = []

        def add_field(name: str, value: Any, port: Optional[str] = None) -> None:
            field = {"name": name, "value": _format_value(value)}
            if port is not None:
                field["port"] = port
            fields.append(field)

        add_field("prev_size", prevSize, "prevSize")
        add_field("size", chunkSize, "size")
        fields.append({"name": "A", "value": _format_flag(a), "port": "flagsA"})
        fields.append({"name": "M", "value": _format_flag(m), "port": "flagsM"})
        fields.append({"name": "P", "value": _format_flag(p), "port": "flagsP"})
        add_field("fd", fd, "fdPtr")
        add_field("bk", bk, "bkPtr")

        chunk: Dict[str, Any] = {
            "index": str(index),
            "address": _format_value(address),
            "prevSize": _format_value(prevSize),
            "chunkSize": _format_value(chunkSize),
            "a": _format_flag(a),
            "m": _format_flag(m),
            "p": _format_flag(p),
            "fd": _format_value(fd),
            "bk": _format_value(bk),
            "headerSize": str(2 * pointer_size),
            "pointerSize": pointer_size,
            "fields": fields,
            "data": data or [],
            "dataAddress": _format_value(data_address),
            "dataSize": _format_value(data_size),
            "dataTruncated": bool(data_truncated),
            "dataDisabled": bool(data_disabled),
        }

        for name, value in (extra_fields or {}).items():
            json_name = {"fd_nextsize": "fdNextSize", "bk_nextsize": "bkNextSize"}.get(name, name)
            port = {"fd_nextsize": "fdNextSize", "bk_nextsize": "bkNextSize"}.get(name, name)
            chunk[json_name] = _format_value(value)
            add_field(name, value, port)

        return chunk

    def _appendStructureField(
        self,
        fields: List[Dict[str, str]],
        name: str,
        value: Any,
        pointer: bool = False,
    ) -> None:
        """Flatten small arrays while keeping management nodes readable."""
        if isinstance(value, (list, tuple)):
            indexed_values = list(enumerate(value))
            if pointer:
                # Arena bin arrays are mostly null pointers. Omitting null
                # entries keeps the important links (top, fastbins, bins)
                # visible instead of consuming the field budget.
                indexed_values = [
                    (index, item)
                    for index, item in indexed_values
                    if _value_to_int(item) not in (None, 0)
                ]
                if not indexed_values:
                    fields.append({"name": f"{name}[...]", "value": "all null"})
                    return
            for index, item in indexed_values[:MAX_STRUCTURE_FIELDS]:
                self._appendStructureField(fields, f"{name}[{index}]", item, pointer)
            if len(indexed_values) > MAX_STRUCTURE_FIELDS:
                fields.append({"name": f"{name}[...]", "value": "..."})
            return

        if isinstance(value, dict):
            for key, item in list(value.items())[:MAX_STRUCTURE_FIELDS]:
                self._appendStructureField(fields, f"{name}[{key}]", item, pointer)
            return

        field: Dict[str, str] = {"name": name, "value": _format_value(value)}
        target = _value_to_int(value) if pointer else None
        if target not in (None, 0):
            field["target"] = hex(target)
        fields.append(field)

    def _objectStructure(
        self,
        obj: Any,
        structure_id: str,
        kind: str,
        label: str,
        field_names: tuple,
        source: str = "pwndbg",
    ) -> Optional[Dict[str, Any]]:
        if obj is None:
            return None

        address = _value_to_int(_safe_attr(obj, "address"))
        if address is None:
            address = _value_to_int(obj)
        fields: List[Dict[str, str]] = []
        for name in field_names:
            value = _safe_attr(obj, name)
            if value is None:
                continue
            self._appendStructureField(fields, name, value, name in POINTER_FIELDS)
            if len(fields) >= MAX_STRUCTURE_FIELDS:
                break

        if address is None and not fields:
            return None
        return {
            "id": structure_id,
            "kind": kind,
            "label": label,
            "address": _format_value(address),
            "fields": fields[:MAX_STRUCTURE_FIELDS],
            "source": source,
        }

    def _gdbStructure(
        self,
        expression: str,
        structure_id: str,
        kind: str,
        label: str,
    ) -> Optional[Dict[str, Any]]:
        """Best-effort DWARF/symbol based structure introspection."""
        try:
            value = gdb.parse_and_eval(expression)
            value_type = value.type.strip_typedefs()
            pointer_code = getattr(gdb, "TYPE_CODE_PTR", object())
            if getattr(value_type, "code", None) == pointer_code:
                address = _value_to_int(value)
                obj = value.dereference()
            else:
                address = _value_to_int(_safe_attr(value, "address"))
                obj = value

            obj_type = obj.type.strip_typedefs()
            fields: List[Dict[str, str]] = []
            for field in obj_type.fields():
                name = getattr(field, "name", None)
                if not name:
                    continue
                try:
                    field_value = obj[name]
                except Exception:
                    continue

                field_type = getattr(field, "type", None)
                field_code = getattr(field_type, "code", None)
                is_pointer = field_code == getattr(gdb, "TYPE_CODE_PTR", object())
                if field_code == getattr(gdb, "TYPE_CODE_ARRAY", object()):
                    try:
                        low, high = field_type.range()
                        field_value = [field_value[index] for index in range(int(low), min(int(high) + 1, int(low) + MAX_STRUCTURE_FIELDS))]
                    except Exception:
                        pass
                self._appendStructureField(fields, name, field_value, is_pointer or name in POINTER_FIELDS)
                if len(fields) >= MAX_STRUCTURE_FIELDS:
                    break

            if address is None and not fields:
                return None
            return {
                "id": structure_id,
                "kind": kind,
                "label": label,
                "address": _format_value(address),
                "fields": fields[:MAX_STRUCTURE_FIELDS],
                "source": "gdb",
            }
        except Exception:
            return None

    def collectManagementStructures(self, allocator: GlibcMemoryAllocator) -> None:
        """Collect available ptmalloc bookkeeping objects without hard failures.

        Pwndbg has changed the names and availability of these wrappers across
        releases. Each source is therefore optional; a partial view is more
        useful than making ``vhstate`` fail for a missing debug symbol.
        """
        structures: List[Dict[str, Any]] = []
        seen_ids = set()

        def append_structure(structure: Optional[Dict[str, Any]]) -> None:
            if structure is None or structure["id"] in seen_ids:
                return
            seen_ids.add(structure["id"])
            structures.append(structure)

        arena = _safe_attr(allocator, "main_arena")
        if arena is None:
            # Older pwndbg releases expose the arena on the heap module rather
            # than on the allocator instance.
            arena = _safe_attr(pwndbg.aglib.heap, "main_arena")
        append_structure(
            self._objectStructure(
                arena,
                "arena_main",
                "malloc_state",
                "main_arena (malloc_state)",
                (
                    "mutex",
                    "flags",
                    "have_fastchunks",
                    "have_fast_chunks",
                    "fastbinsY",
                    "fastbins",
                    "top",
                    "last_remainder",
                    "bins",
                    "binmap",
                    "next",
                    "next_free",
                    "attached_threads",
                    "system_mem",
                    "max_system_mem",
                ),
            )
        )

        # Some Pwndbg versions expose arena/heap collections directly.
        for attr, kind, label, field_names in (
            (
                "arenas",
                "malloc_state",
                "arena",
                ("mutex", "flags", "top", "last_remainder", "next", "next_free", "system_mem", "max_system_mem"),
            ),
            (
                "all_arenas",
                "malloc_state",
                "arena",
                ("mutex", "flags", "top", "last_remainder", "next", "next_free", "system_mem", "max_system_mem"),
            ),
            (
                "heap_info",
                "heap_info",
                "heap_info",
                ("ar_ptr", "prev", "size", "mprotect_size"),
            ),
            (
                "heap_infos",
                "heap_info",
                "heap_info",
                ("ar_ptr", "prev", "size", "mprotect_size"),
            ),
        ):
            candidates = _safe_attr(allocator, attr)
            if candidates is None:
                continue
            if isinstance(candidates, dict):
                candidates = list(candidates.values())
            elif not isinstance(candidates, (list, tuple, set)):
                try:
                    candidates = list(candidates)
                except Exception:
                    candidates = [candidates]
            for index, candidate in enumerate(candidates):
                append_structure(
                    self._objectStructure(
                        candidate,
                        f"{kind}_{attr}_{index}",
                        kind,
                        f"{label}[{index}] ({kind})",
                        field_names,
                    )
                )

        # libc's malloc parameters are often available only as a GDB symbol.
        append_structure(self._gdbStructure("&mp_", "malloc_par", "malloc_par", "mp_ (malloc_par)"))
        if arena is None:
            append_structure(self._gdbStructure("&main_arena", "arena_main", "malloc_state", "main_arena (malloc_state)"))

        # A few Pwndbg revisions expose the per-thread tcache wrapper.
        for source_obj in (allocator, pwndbg.aglib.heap):
            for attr in ("tcache", "tcache_perthread_struct", "tcache_struct"):
                candidate = _safe_attr(source_obj, attr)
                append_structure(
                    self._objectStructure(
                        candidate,
                        f"tcache_{attr}",
                        "tcache_perthread_struct",
                        f"{attr} (tcache_perthread_struct)",
                        ("counts", "entries"),
                    )
                )

        # Even when the libc tcache symbol is stripped, the bin heads are a
        # useful, explicitly marked representation of its entries array.
        tcache_fields: List[Dict[str, str]] = []
        for head, address in self.binsheads.items():
            if head.startswith("tcachebinshead"):
                self._appendStructureField(
                    tcache_fields,
                    head.replace("head", ""),
                    address,
                    pointer=True,
                )
        if tcache_fields:
            append_structure(
                {
                    "id": "tcache_derived",
                    "kind": "tcache_perthread_struct",
                    "label": "tcache bins (derived)",
                    "address": "None",
                    "fields": tcache_fields,
                    "source": "derived",
                }
            )

        with self.state_lock:
            self.structures = structures


vheap = VisualHeap()


def gdb_stop_handler(_event):
    vhstate()


def gdb_exit_handler(_event):
    vheap.stop()


gdb.events.gdb_exiting.connect(gdb_exit_handler)
