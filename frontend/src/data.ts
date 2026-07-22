import type {
  DataRow,
  DisplayChunk,
  HeapChunk,
  HeapField,
  HeapSnapshot,
  ManagementStructure,
  ChunkViewType,
  MemoryViewRecord,
} from "./types";

export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(value: unknown, fallback = "None"): string {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function firstDefined(record: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

export function hexNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = text(value, "").trim();
  if (!raw || raw === "None") return Number.NaN;
  const parsed = raw.toLowerCase().startsWith("0x") ? Number.parseInt(raw, 16) : Number(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Parse an address without losing the high bits of a 64-bit target pointer. */
export function parseAddress(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n && value <= 0xffffffffffffffffn ? value : null;
  if (typeof value === "number") {
    return Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
      ? BigInt(value)
      : null;
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw === "None" || raw === "-") return null;
  if (!/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(raw)) return null;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n && parsed <= 0xffffffffffffffffn ? parsed : null;
  } catch {
    return null;
  }
}

export function canonicalAddress(value: unknown): string {
  const parsed = parseAddress(value);
  return parsed === null ? text(value, "None").trim() : `0x${parsed.toString(16)}`;
}

export function formatHex(value: number): string {
  return Number.isFinite(value) ? `0x${Math.max(0, Math.trunc(value)).toString(16)}` : "None";
}

export function isPointer(value: unknown): boolean {
  const numeric = hexNumber(value);
  return Number.isFinite(numeric) && numeric !== 0;
}

export function normaliseField(value: unknown): HeapField | null {
  if (!isRecord(value)) return null;
  const target = firstDefined(value, "target", "pointer");
  return {
    name: text(firstDefined(value, "name", "field"), "field"),
    value: text(firstDefined(value, "value", "val")),
    ...(firstDefined(value, "port", "handle") ? { port: text(firstDefined(value, "port", "handle")) } : {}),
    ...(target ? { target: text(target) } : {}),
  };
}

export function normaliseDataRow(value: unknown): DataRow | null {
  if (!isRecord(value)) return null;
  return {
    offset: text(firstDefined(value, "offset"), "0x0"),
    address: text(firstDefined(value, "address", "addr")),
    value: text(firstDefined(value, "value", "word")),
    ...(firstDefined(value, "bytes", "hex") ? { bytes: text(firstDefined(value, "bytes", "hex")) } : {}),
    ...(firstDefined(value, "ascii", "text") !== undefined ? { ascii: text(firstDefined(value, "ascii", "text"), "") } : {}),
  };
}

export function normaliseChunk(value: unknown, fallbackIndex: number, defaultPointerSize?: number): HeapChunk {
  const raw = isRecord(value) ? value : {};
  const rawPointerSize = Number(firstDefined(raw, "pointerSize", "pointer_size"));
  const pointerSize = rawPointerSize === 4 || rawPointerSize === 8
    ? rawPointerSize
    : defaultPointerSize === 4 || defaultPointerSize === 8
      ? defaultPointerSize
      : undefined;
  const fields = Array.isArray(raw.fields)
    ? raw.fields.map(normaliseField).filter((field): field is HeapField => field !== null)
    : undefined;
  const data = Array.isArray(raw.data)
    ? raw.data.map(normaliseDataRow).filter((row): row is DataRow => row !== null)
    : undefined;

  return {
    index: text(firstDefined(raw, "index", "id"), String(fallbackIndex)),
    address: text(firstDefined(raw, "address", "addr")),
    prevSize: text(firstDefined(raw, "prevSize", "prev_size")),
    chunkSize: text(firstDefined(raw, "chunkSize", "chunk_size", "size")),
    a: text(firstDefined(raw, "a", "A"), "0"),
    m: text(firstDefined(raw, "m", "M"), "0"),
    p: text(firstDefined(raw, "p", "P"), "0"),
    fd: text(firstDefined(raw, "fd", "forward")),
    bk: text(firstDefined(raw, "bk", "back")),
    ...(firstDefined(raw, "fdNextSize", "fd_nextsize") !== undefined ? { fdNextSize: text(firstDefined(raw, "fdNextSize", "fd_nextsize")) } : {}),
    ...(firstDefined(raw, "bkNextSize", "bk_nextsize") !== undefined ? { bkNextSize: text(firstDefined(raw, "bkNextSize", "bk_nextsize")) } : {}),
    ...(firstDefined(raw, "headerSize", "header_size") !== undefined ? { headerSize: text(firstDefined(raw, "headerSize", "header_size")) } : {}),
    ...(fields ? { fields } : {}),
    ...(data ? { data } : {}),
    ...(firstDefined(raw, "dataAddress", "data_address") !== undefined ? { dataAddress: text(firstDefined(raw, "dataAddress", "data_address")) } : {}),
    ...(firstDefined(raw, "dataSize", "data_size") !== undefined ? { dataSize: text(firstDefined(raw, "dataSize", "data_size")) } : {}),
    ...(pointerSize ? { pointerSize } : {}),
    ...(typeof firstDefined(raw, "dataTruncated", "data_truncated") === "boolean" ? { dataTruncated: firstDefined(raw, "dataTruncated", "data_truncated") as boolean } : {}),
    ...(typeof firstDefined(raw, "dataDisabled", "data_disabled") === "boolean" ? { dataDisabled: firstDefined(raw, "dataDisabled", "data_disabled") as boolean } : {}),
  };
}

export function normaliseStructure(value: unknown, fallbackIndex: number): ManagementStructure {
  const raw = isRecord(value) ? value : {};
  const fields = Array.isArray(raw.fields)
    ? raw.fields.map(normaliseField).filter((field): field is HeapField => field !== null)
    : [];
  return {
    id: text(raw.id, `structure_${fallbackIndex}`),
    kind: text(raw.kind, "structure"),
    label: text(raw.label, text(raw.kind, "structure")),
    address: text(raw.address),
    ...(raw.source ? { source: text(raw.source) } : {}),
    fields,
  };
}

export function parseSnapshot(input: unknown): HeapSnapshot {
  const parsed: unknown = typeof input === "string" ? JSON.parse(input) : input;
  if (!isRecord(parsed)) throw new Error("Heap snapshot is not an object");

  const heads: Record<string, string> = {};
  if (isRecord(parsed.heads)) {
    for (const [key, value] of Object.entries(parsed.heads)) heads[key] = text(value);
  }

  const snapshotPointerSize = Number(parsed.pointerSize);
  const defaultPointerSize = snapshotPointerSize === 4 || snapshotPointerSize === 8 ? snapshotPointerSize : undefined;
  const bins: Record<string, HeapChunk[]> = {};
  if (isRecord(parsed.bins)) {
    for (const [name, value] of Object.entries(parsed.bins)) {
      bins[name] = Array.isArray(value) ? value.map((chunk, index) => normaliseChunk(chunk, index, defaultPointerSize)) : [];
    }
  }

  const structures = Array.isArray(parsed.structures)
    ? parsed.structures.map(normaliseStructure)
    : [];
  return {
    ...(typeof parsed.version === "number" ? { version: parsed.version } : {}),
    ...(defaultPointerSize ? { pointerSize: defaultPointerSize } : {}),
    heads,
    bins,
    structures,
  };
}

export function chunkHeaderSize(chunk: HeapChunk): number {
  const value = hexNumber(chunk.headerSize);
  if (Number.isFinite(value) && value > 0) return value;
  const pointerSize = chunk.pointerSize === 4 ? 4 : 8;
  return 2 * pointerSize;
}

export function isTcacheBin(bin: string): boolean {
  return bin.toLowerCase().includes("tcache");
}

export function chunkBaseAddress(chunk: HeapChunk, bin: string): number {
  const address = hexNumber(chunk.address);
  if (!Number.isFinite(address)) return Number.NaN;
  return isTcacheBin(bin) ? address - chunkHeaderSize(chunk) : address;
}

export function fieldRows(chunk: HeapChunk): HeapField[] {
  if (chunk.fields && chunk.fields.length > 0) return chunk.fields;
  const fields: HeapField[] = [
    { name: "prev_size", value: chunk.prevSize, port: "prevSize" },
    { name: "size", value: chunk.chunkSize, port: "size" },
    { name: "A", value: chunk.a, port: "flagsA" },
    { name: "M", value: chunk.m, port: "flagsM" },
    { name: "P", value: chunk.p, port: "flagsP" },
    { name: "fd", value: chunk.fd, port: "fdPtr" },
    { name: "bk", value: chunk.bk, port: "bkPtr" },
  ];
  if (chunk.fdNextSize !== undefined) fields.push({ name: "fd_nextsize", value: chunk.fdNextSize, port: "fdNextSize" });
  if (chunk.bkNextSize !== undefined) fields.push({ name: "bk_nextsize", value: chunk.bkNextSize, port: "bkNextSize" });
  return fields;
}

export function dataRows(chunk: HeapChunk): DataRow[] {
  return chunk.data ?? [];
}

export function displayBinNames(snapshot: HeapSnapshot): string[] {
  return Object.keys(snapshot.bins)
    .filter((name) => name !== "allchunks" && snapshot.bins[name].length > 0)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

export function displayChunks(snapshot: HeapSnapshot, visibleBins: Set<string>): DisplayChunk[] {
  const result: DisplayChunk[] = [];
  const freeBases = new Set<string>();

  for (const [bin, chunks] of Object.entries(snapshot.bins)) {
    if (bin === "allchunks") continue;
    for (const chunk of chunks) {
      const base = chunkBaseAddress(chunk, bin);
      if (Number.isFinite(base)) freeBases.add(formatHex(base));
      if (visibleBins.has(bin)) {
        result.push({ id: `chunk:${bin}:${chunk.index}:${chunk.address}`, bin, chunk });
      }
    }
  }

  if (visibleBins.has("allocated")) {
    for (const chunk of snapshot.bins.allchunks ?? []) {
      const base = chunkBaseAddress(chunk, "allchunks");
      if (Number.isFinite(base) && freeBases.has(formatHex(base))) continue;
      result.push({
        id: `chunk:allocated:${chunk.index}:${chunk.address}`,
        bin: "allocated",
        chunk,
      });
    }
  }
  return result;
}

export function searchMatches(value: string, query: string): boolean {
  return !query || value.toLowerCase().includes(query.trim().toLowerCase());
}

function decodeBytes(value: string): number[] {
  const clean = value.replace(/^0x/i, "").replace(/[^0-9a-f]/gi, "");
  if (!clean) return [];
  const normalized = clean.length % 2 === 0 ? clean : `0${clean}`;
  const bytes: number[] = [];
  for (let index = 0; index < normalized.length; index += 2) {
    bytes.push(Number.parseInt(normalized.slice(index, index + 2), 16));
  }
  return bytes;
}

function rowBytes(row: DataRow, pointerSize: number): number[] {
  if (row.bytes) return decodeBytes(row.bytes).slice(0, pointerSize);
  try {
    const value = BigInt(row.value);
    return Array.from({ length: pointerSize }, (_, index) => Number((value >> BigInt(index * 8)) & 0xffn));
  } catch {
    return [];
  }
}

export function memoryViewId(address: string, type: ChunkViewType): string {
  return `memory:${canonicalAddress(address)}:${type}`;
}

export interface SnapshotMemoryRead {
  rows: DataRow[];
  availableSize: number;
  pointerSize: number;
}

/** Read an address range from already-captured chunk rows (used by demo mode). */
export function readSnapshotMemory(snapshot: HeapSnapshot, address: string | number | bigint, size: number): SnapshotMemoryRead {
  const pointerSize = snapshot.pointerSize === 4 ? 4 : 8;
  const startAddress = parseAddress(address);
  if (startAddress === null || size <= 0) return { rows: [], availableSize: 0, pointerSize };
  const bytes = new Map<bigint, number>();
  const addChunkRows = (chunk: HeapChunk): void => {
    const chunkPointerSize = chunk.pointerSize === 4 ? 4 : pointerSize;
    const dataAddress = parseAddress(chunk.dataAddress);
    for (const row of dataRows(chunk)) {
      const rowAddress = parseAddress(row.address);
      const offset = parseAddress(row.offset);
      const rowStart = rowAddress ?? (dataAddress !== null && offset !== null
        ? dataAddress + offset
        : null);
      if (rowStart === null) continue;
      rowBytes(row, chunkPointerSize).forEach((byte, index) => bytes.set(rowStart + BigInt(index), byte));
    }
  };

  for (const chunks of Object.values(snapshot.bins)) chunks.forEach(addChunkRows);
  const availableSize = (() => {
    let count = 0;
    while (count < size && bytes.has(startAddress + BigInt(count))) count += 1;
    return count;
  })();
  const rows: DataRow[] = [];
  for (let offset = 0; offset < availableSize; offset += pointerSize) {
    const part = Array.from({ length: Math.min(pointerSize, availableSize - offset) }, (_, index) => bytes.get(startAddress + BigInt(offset + index)) ?? 0);
    const value = part.reduce((result, byte, index) => result | (BigInt(byte) << BigInt(index * 8)), 0n);
    rows.push({
      offset: formatHex(offset),
      address: `0x${(startAddress + BigInt(offset)).toString(16)}`,
      value: `0x${value.toString(16)}`,
      bytes: part.map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      ascii: part.map((byte) => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".").join(""),
    });
  }
  return { rows, availableSize, pointerSize };
}

export function normaliseMemoryView(value: unknown, fallbackType: ChunkViewType): MemoryViewRecord | null {
  if (!isRecord(value)) return null;
  const address = text(value.address, "None");
  const rawType = text(value.type, fallbackType) as ChunkViewType;
  const validTypes: ChunkViewType[] = ["malloc_chunk", "io_file", "io_file_plus", "io_jump_t", "io_wide_data"];
  const type = validTypes.includes(rawType) ? rawType : fallbackType;
  const pointerSize = Number(value.pointerSize) === 4 ? 4 : 8;
  const rows = Array.isArray(value.data)
    ? value.data.map(normaliseDataRow).filter((row): row is DataRow => row !== null)
    : [];
  return {
    id: text(value.id, memoryViewId(address, type)),
    address,
    type,
    pointerSize,
    requestedSize: Number(value.requestedSize) || Number(value.dataSize) || 0,
    availableSize: Number(value.availableSize) || 0,
    data: rows,
    dataTruncated: value.dataTruncated === true,
    ...(value.dataDisabled === true ? { dataDisabled: true } : {}),
    ...(value.source ? { source: text(value.source) } : {}),
    ...(value.error ? { error: text(value.error) } : {}),
  };
}

function demoChunk(
  index: number,
  address: string,
  size: string,
  fd: string,
  binData: string,
  payload: string,
): HeapChunk {
  return {
    index: String(index),
    address,
    prevSize: "0x0",
    chunkSize: size,
    a: "0",
    m: "0",
    p: "1",
    fd,
    bk: "0x0",
    headerSize: "16",
    pointerSize: 8,
    dataAddress: address,
    dataSize: "0x40",
    dataTruncated: true,
    data: [
      { offset: "0x0", address, value: payload, bytes: binData, ascii: "heap-data" },
      { offset: "0x8", address: formatHex(hexNumber(address) + 8), value: fd, bytes: "0000000000000000", ascii: "........" },
    ],
  };
}

function littleEndianHex(value: bigint, width: number): string {
  let result = "";
  for (let index = 0; index < width; index += 1) {
    result += Number((value >> BigInt(index * 8)) & 0xffn).toString(16).padStart(2, "0");
  }
  return result;
}

function demoIoPayload(address: string): DataRow[] {
  const words = [
    0xfbad2887n,
    0x4141414141414141n,
    0x4141414141414141n,
    0x4141414141414141n,
    0x4242424242424242n,
    0x4242424242424242n,
    0x4242424242424242n,
    0x4343434343434343n,
    0x4343434343434343n,
    0x0n,
    0x0n,
    0x0n,
    0x0n,
    0x0n,
    (0x80n << 32n) | 0x1n,
    0xffffffffffffffffn,
    0x80n,
    0x0n,
    0x0n,
    0x7ffff7dd18c0n,
    0x0n,
    0x0n,
    0x0n,
    0x0n,
    0x0n,
    0x0n,
    0x0n,
    0x7ffff7e1b000n,
  ];
  return words.map((word, index) => {
    const offset = index * 8;
    const rowAddress = formatHex(hexNumber(address) + offset);
    const bytes = littleEndianHex(word, 8);
    return {
      offset: formatHex(offset),
      address: rowAddress,
      value: `0x${word.toString(16)}`,
      bytes,
      ascii: "........",
    };
  });
}

export function demoSnapshot(): HeapSnapshot {
  const allocated = (index: number, address: string, size: string, payload: string): HeapChunk => ({
    ...demoChunk(index, address, size, "0x0", "4141414141414141", payload),
    a: "1",
    dataDisabled: false,
  });
  return {
    version: 2,
    pointerSize: 8,
    heads: {
      tcachebinshead0: "0x7000",
      fastbinshead1: "0x8000",
      largebinshead2: "0x9000",
      allocated: "3",
    },
    bins: {
      tcachebins0: [demoChunk(0, "0x7000", "0x30", "0x7010", "1020304050607080", "0x8070605040302010")],
      fastbins1: [demoChunk(0, "0x8000", "0x40", "0x8010", "9090909090909090", "0x9090909090909090")],
      largebins2: [
        {
          ...demoChunk(0, "0x9000", "0x420", "0x9010", "deadc0dedeadc0de", "0xdec0addedec0adde"),
          fdNextSize: "0xa000",
          bkNextSize: "0x0",
        },
      ],
      allchunks: [
        allocated(0, "0x1000", "0x80", "0x4141414141414141"),
        {
          ...allocated(1, "0x2000", "0x120", "0xfbad2887"),
          dataSize: "0xe0",
          dataTruncated: false,
          data: demoIoPayload("0x2000"),
        },
        allocated(2, "0x3000", "0x60", "0x4343434343434343"),
        demoChunk(3, "0x6ff0", "0x30", "0x7000", "0000000000000000", "0x0"),
        demoChunk(4, "0x8000", "0x40", "0x8010", "0000000000000000", "0x0"),
        demoChunk(5, "0x9000", "0x420", "0x9010", "0000000000000000", "0x0"),
      ],
    },
    structures: [
      {
        id: "arena_main",
        kind: "malloc_state",
        label: "main_arena (malloc_state)",
        address: "0x5000",
        source: "demo",
        fields: [
          { name: "top", value: "0x1000", target: "0x1000" },
          { name: "fastbinsY[1]", value: "0x8000", target: "0x8000" },
          { name: "system_mem", value: "0x20000" },
          { name: "max_system_mem", value: "0x40000" },
        ],
      },
      {
        id: "heap_main",
        kind: "heap_info",
        label: "heap_info",
        address: "0x6fe0",
        source: "demo",
        fields: [
          { name: "ar_ptr", value: "0x5000", target: "0x5000" },
          { name: "size", value: "0x21000" },
          { name: "mprotect_size", value: "0x21000" },
        ],
      },
      {
        id: "tcache_derived",
        kind: "tcache_perthread_struct",
        label: "tcache_perthread_struct",
        address: "None",
        source: "demo",
        fields: [{ name: "entries[0]", value: "0x7000", target: "0x7000" }],
      },
    ],
  };
}
