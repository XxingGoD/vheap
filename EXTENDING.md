# Extending vHeap

All you need to do to extend is take a look at the [extended.js](https://github.com/wes4m/vheap/blob/master/vheapViews/static/js/extended.js) file.
Extensions are based on callbacks. 

The file also includes a few examples to follow.
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

An extension can append a row to `chunk.extended.rows` or set
`chunk.extended.backgroundColor` before DOT generation. Management structures
are available through the top-level `structures` array. Each structure has an
`id`, `kind`, `label`, `address`, and a list of fields; a field may include a
`target` address to create a visual reference to another structure or chunk.

Payload size is controlled from GDB with `vhserv --data-bytes N` or
`vhstate --data-bytes N`. Set it to `0` when a large heap should be rendered
without reading payload memory.


> TO DO: Explaining this section better (Although it doesn't really need much explination)
