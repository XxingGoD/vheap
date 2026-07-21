# vHeap
Extendable Visualization &amp; Exploitation tool for glibc heap.

vHeap is a Python and TypeScript project aimed at visualizing glibc heap memory at runtime during debugging sessions.

The heap memory is one of those things that are much easier to work with and learn when visualized. Most security researchers/ctf players end up sketching the heap memory to exploit it.

## Showcase
![vHeapGif](imgs/vHeapDynamicDemo.gif)
![vHeapPng](imgs/vHeapStaticDemo.png)

## Support & installation
This vHeap version is built to work with [pwndbg](https://github.com/pwndbg/pwndbg) on GDB (requires GDB v11 and higher).

Clone and install [pwndbg](https://github.com/pwndbg/pwndbg) then
```
git clone https://github.com/wes4m/vheap.git
cd vheap
./setup.sh PWNDBG_PATH
```
## Usage
To start serving; from within your GDB session vHeap shows you everything in the webbrowser.
```
vhserv localhost 1337 --data-bytes 64
```
`vhstop` to stop the server.

Each chunk includes a bounded view of its payload. Increase or reduce the
bound without restarting the server with:
```
vhstate --data-bytes 256
vhstate --data-bytes 0       # hide payload bytes
```
The value is measured in bytes and is rendered as pointer-sized rows. The
default is 64 bytes per chunk. Snapshots also carry the target's 32/64-bit
pointer width so the IO layouts use the correct ABI automatically.

### Reinterpret a chunk for IO exploitation

Select a chunk in the Inspector and use the `reinterpret payload` menu to view
the same bytes as `malloc_chunk`, `_IO_FILE`, `_IO_FILE_plus`, `_IO_jump_t`, or
`_IO_wide_data`. The IO layouts use the active pointer width and show field
offsets, sizes, decoded pointers, and common `_IO_FILE` flag names (including
the modern `_total_written` tail). This is a memory view only; it does not
change glibc's allocator metadata.

An `_IO_FILE` is larger than the default payload window. Collect enough bytes
before switching views, for example:

```gdb
vhstate --data-bytes 256
```

If the payload is truncated, the Inspector marks fields beyond the captured
range as unavailable and suggests a larger `--data-bytes` value. The built-in
`?demo=1` snapshot includes an example `_IO_FILE_plus` payload.
On a 64-bit target the common `_IO_FILE_plus` `vtable` appears at offset
`0xd8`; verify offsets against the challenge's libc before crafting a payload.

To update the heap state.
```
vhstate
```
The heap state is updated automatically on each stop. You can disable auto updating using the `vhserv --no-auto-update` argument during vheap start.

By default the view also adds best-effort `malloc_state`/arena, `heap_info`,
`malloc_par`, and tcache management nodes when the active Pwndbg or libc
symbols expose them. Use `vhserv --no-structures` or `vhstate --no-structures`
to disable this collection.

## TypeScript frontend

The current frontend is a Vite + React + TypeScript application. It uses
React Flow and ELK to lay out chunk links, bin heads, and ptmalloc management
structures, while keeping the existing Socket.IO heap snapshot protocol.

`setup.sh` builds the bundle automatically when pnpm is available. The build
requires Node.js 20.19 or newer and pnpm 10. To build it manually, install the
frontend dependencies from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
```

`vhserv` serves the resulting `vheapViews/dist` directory. For local UI work,
run `pnpm dev` and open `http://127.0.0.1:5173/?demo=1` to use the built-in
snapshot without starting GDB. `pnpm typecheck` runs the strict TypeScript
check without emitting files.

## Extending
vHeap can be easily modified to work with other debuggers and any other form of input methods.
It is also built while keeping in mind extendability and adding custom functionalities; More at [EXTENDING DOCS](https://github.com/wes4m/vheap/blob/master/EXTENDING.md).


## Current status
vHeap to do tasks:
-  Selecting different arenas.
-  Better overlap detection.
-  Making docs.
-  ?? ..

Contributions are appreciated 💛.
