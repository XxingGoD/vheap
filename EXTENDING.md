# Extending vHeap

The legacy Graphviz renderer remains in `vheapViews/static/js` as a fallback.
New UI work belongs in `frontend/src`, where the data model and graph builder
are typed TypeScript modules. Extensions are based on the same JSON snapshot
contract, so a debugger adapter does not need to know about React components.

The legacy file includes a few callback examples to follow.
The double free detection and overlap detection shown in the demo are extension
functionalities.

## Chunk data model

The server keeps the original scalar fields (`address`, `prevSize`,
`chunkSize`, `fd`, and `bk`) for compatibility. Newer snapshots additionally
contain:

- `fields`: an ordered list of `{name, value, port}` rows. Optional allocator
  fields such as `fd_nextsize` and `bk_nextsize` can be appended here.
- `data`: bounded payload rows with `offset`, `address`, `value`, `bytes`, and
  `ascii` values.
- `dataSize`, `dataAddress`, `dataTruncated`, and `dataDisabled` metadata.
- top-level and per-chunk `pointerSize`, which let the frontend select the
  correct ABI width when it reinterprets payload bytes.

An extension can append a row to `chunk.extended.rows`. Management structures
are available through the top-level `structures` array.
Each structure has an
`id`, `kind`, `label`, `address`, and a list of fields; a field may include a
`target` address to create a visual reference to another structure or chunk.

Payload size is controlled from GDB with `vhserv --data-bytes N` or
`vhstate --data-bytes N`. Set it to `0` when a large heap should be rendered
without reading payload memory.

## Address memory views

The TypeScript frontend keeps user-created address dumps in `MemoryViewRecord`
values. A record contains the canonical `address`, selected `type`, target
`pointerSize`, requested/available byte counts, and the same `DataRow[]` format
used by chunk payloads. `type: "raw_memory"` is the default and only displays
bytes; a `ChunkViewType` such as `io_file` opts into field decoding and typed
pointer edges. `frontend/src/graph.ts` adds each record as a `memory` node and
resolves typed pointer fields against chunk, management-structure, and other
memory-node address indexes.

Live clients request bytes with Socket.IO:

```json
{"requestId":"memory-1","address":"0x7ffff7dd18c0","type":"raw_memory","size":256}
```

The server replies on `memoryData` with `requestId`, `address`, `type`,
`pointerSize`, `requestedSize`, `availableSize`, `data`, `dataTruncated`, and
an optional `error`. The handler schedules the read through `gdb.post_event`,
so debugger APIs are not called from the aiohttp thread. Requests are capped at `0x10000`
bytes. A frontend adapter can implement the same event contract and reuse
`reinterpretMemoryRows` for a different debugger or transport.

The `MemoryRegionView` component expands the shared `DataRow[]` payload into
16-byte rows through `memoryRegionRows`. It preserves the requested range when
only a prefix is available, allowing the UI to mark unread cells as `--`.
Adapters that return explicit `bytes` fields get byte-accurate output; when
those fields are absent, values are decoded as little-endian pointer-sized
words.

## Chunk type views

`frontend/src/structViews.ts` contains the typed payload view registry. A view
is a list of little-endian field specifications (`offset`, `size`, and scalar
kind). The Inspector currently ships with `malloc_chunk`, `_IO_FILE`,
`_IO_FILE_plus`, `_IO_jump_t`, and a partial `_IO_wide_data` view. Add a new
`ChunkViewType`, option, and layout builder there to support another glibc
structure without changing the allocator collector or Socket.IO protocol.

The `_IO_FILE` tail differs slightly between glibc releases: newer versions
name fields such as `_prevchain` and `_total_written`, while older versions use
the same bytes as `__pad5`/`_unused2`. The view keeps those offsets stable and
labels the ABI-specific fields. Always compare it with the target libc's
`pahole`/`ptype` output when an exploit depends on a version-specific tail
field.


> TO DO: Explaining this section better (Although it doesn't really need much explination)
