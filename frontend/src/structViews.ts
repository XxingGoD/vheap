import { dataRows, formatHex, hexNumber } from "./data";
import type { ChunkView, ChunkViewField, ChunkViewType, DataRow, HeapChunk } from "./types";

type FieldKind = "pointer" | "u64" | "s64" | "u32" | "u24" | "s32" | "u16" | "s16" | "u8" | "s8" | "bytes";

interface FieldSpec {
  name: string;
  offset: number;
  size: number;
  kind: FieldKind;
  note?: string;
}

interface ViewSpec {
  label: string;
  fields: FieldSpec[];
  expectedSize: number;
}

export interface ChunkViewOption {
  value: ChunkViewType;
  label: string;
  description: string;
}

export const CHUNK_VIEW_OPTIONS: ChunkViewOption[] = [
  { value: "malloc_chunk", label: "malloc_chunk", description: "Allocator header and bin links" },
  { value: "io_file", label: "_IO_FILE", description: "glibc FILE object (ABI-aware layout)" },
  { value: "io_file_plus", label: "_IO_FILE_plus", description: "_IO_FILE followed by a vtable pointer" },
  { value: "io_jump_t", label: "_IO_jump_t", description: "FILE virtual function table" },
  { value: "io_wide_data", label: "_IO_wide_data", description: "Wide-stream backing structure (partial)" },
];

const IO_FLAG_NAMES: Array<[number, string]> = [
  [0x0001, "_IO_USER_BUF"],
  [0x0002, "_IO_UNBUFFERED"],
  [0x0004, "_IO_NO_READS"],
  [0x0008, "_IO_NO_WRITES"],
  [0x0010, "_IO_EOF_SEEN"],
  [0x0020, "_IO_ERR_SEEN"],
  [0x0040, "_IO_DELETE_DONT_CLOSE"],
  [0x0080, "_IO_LINKED"],
  [0x0100, "_IO_IN_BACKUP"],
  [0x0200, "_IO_LINE_BUF"],
  [0x0400, "_IO_TIED_PUT_GET"],
  [0x0800, "_IO_CURRENTLY_PUTTING"],
  [0x1000, "_IO_IS_APPENDING"],
  [0x2000, "_IO_IS_FILEBUF"],
  [0x4000, "_IO_BAD_SEEN"],
  [0x8000, "_IO_USER_LOCK"],
];

const IO_FLAGS2_NAMES: Array<[number, string]> = [
  [0x0001, "_IO_FLAGS2_MMAP"],
  [0x0002, "_IO_FLAGS2_NOTCANCEL"],
  [0x0008, "_IO_FLAGS2_USER_WBUF"],
  [0x0020, "_IO_FLAGS2_NOCLOSE"],
  [0x0040, "_IO_FLAGS2_CLOEXEC"],
  [0x0080, "_IO_FLAGS2_NEED_LOCK"],
];

function align(offset: number, alignment: number): number {
  return Math.ceil(offset / alignment) * alignment;
}

function field(name: string, offset: number, size: number, kind: FieldKind, note?: string): FieldSpec {
  return { name, offset, size, kind, ...(note ? { note } : {}) };
}

function pointerFields(names: string[], start: number, pointerSize: number): FieldSpec[] {
  return names.map((name, index) => field(name, start + index * pointerSize, pointerSize, "pointer"));
}

/**
 * Build the public _IO_FILE layout instead of hard-coding only 64-bit offsets.
 * The tail is intentionally named for both historical __pad5 and newer
 * _prevchain ABIs; the offsets used by common glibc releases are identical.
 * Modern glibc also exposes a written-byte counter in the final padding area.
 */
function ioFileSpec(pointerSize: number): ViewSpec {
  const p = pointerSize === 4 ? 4 : 8;
  const fields: FieldSpec[] = [];
  let offset = 0;
  const add = (name: string, size: number, kind: FieldKind, note?: string) => {
    fields.push(field(name, offset, size, kind, note));
    offset += size;
  };

  add("_flags", 4, "u32", "high 16 bits normally contain _IO_MAGIC");
  offset = align(offset, p);
  const streamPointers = [
    "_IO_read_ptr",
    "_IO_read_end",
    "_IO_read_base",
    "_IO_write_base",
    "_IO_write_ptr",
    "_IO_write_end",
    "_IO_buf_base",
    "_IO_buf_end",
    "_IO_save_base",
    "_IO_backup_base",
    "_IO_save_end",
  ];
  fields.push(...pointerFields(streamPointers, offset, p));
  offset += streamPointers.length * p;
  add("_markers", p, "pointer");
  add("_chain", p, "pointer");
  add("_fileno", 4, "s32");
  // _flags2 is a 24-bit bit-field. The adjacent byte is the short backup
  // buffer, so keeping both fields explicit makes the offsets useful when
  // inspecting a forged FILE rather than hiding the byte in a 32-bit value.
  add("_flags2", 3, "u24", "24-bit field");
  add("_short_backupbuf[0]", 1, "u8", "fallback byte adjacent to _flags2");
  add("_old_offset", p === 8 ? 8 : 4, p === 8 ? "s64" : "s32");
  add("_cur_column", 2, "u16");
  add("_vtable_offset", 1, "s8");
  add("_shortbuf[0]", 1, "u8");
  offset = align(offset, p);
  add("_lock", p, "pointer");
  offset = align(offset, p);
  add("_offset", 8, "s64");
  add("_codecvt", p, "pointer");
  add("_wide_data", p, "pointer");
  add("_freeres_list", p, "pointer");
  add("_freeres_buf", p, "pointer");
  add("__pad5 / _prevchain", p, "pointer", "name differs between glibc ABIs");
  add("_mode", 4, "s32");
  // Recent glibc keeps counters in the tail while older releases used the
  // same bytes as opaque _unused2 padding. The total size remains stable,
  // which lets this view work for both ABIs without moving vtable.
  if (p === 8) {
    add("_unused3", 4, "u32", "modern glibc; padding in older ABI");
    add("_total_written", 8, "u64", "modern glibc; padding in older ABI");
  } else {
    add("_total_written", 8, "u64", "modern glibc; padding in older ABI");
    add("_unused3", 4, "u32", "modern glibc; padding in older ABI");
  }
  add("_unused2", 12 * 4 - 5 * p, "bytes", "ABI tail padding");

  return { label: "_IO_FILE", fields, expectedSize: align(offset, p) };
}

function ioFilePlusSpec(pointerSize: number): ViewSpec {
  const base = ioFileSpec(pointerSize);
  const p = pointerSize === 4 ? 4 : 8;
  return {
    label: "_IO_FILE_plus",
    fields: [...base.fields, field("vtable", base.expectedSize, p, "pointer", "struct _IO_jump_t *")],
    expectedSize: base.expectedSize + p,
  };
}

function ioJumpSpec(pointerSize: number): ViewSpec {
  const p = pointerSize === 4 ? 4 : 8;
  const names = [
    "__dummy",
    "__dummy2",
    "__finish",
    "__overflow",
    "__underflow",
    "__uflow",
    "__pbackfail",
    "__xsputn",
    "__xsgetn",
    "__seekoff",
    "__seekpos",
    "__setbuf",
    "__sync",
    "__doallocate",
    "__read",
    "__write",
    "__seek",
    "__close",
    "__stat",
    "__showmanyc",
    "__imbue",
  ];
  const sizeKind: FieldKind = p === 8 ? "u64" : "u32";
  const fields: FieldSpec[] = [
    field("__dummy", 0, p, sizeKind, "size_t slot"),
    field("__dummy2", p, p, sizeKind, "size_t slot"),
    ...pointerFields(names.slice(2), 2 * p, p).map((item) => ({ ...item, note: "function pointer" })),
  ];
  return {
    label: "_IO_jump_t",
    fields,
    expectedSize: names.length * p,
  };
}

/**
 * _IO_wide_data contains an embedded, ABI-specific _IO_codecvt object. The
 * stable pointer/state prefix is still useful for heap IO challenges, while
 * the opaque tail keeps us from presenting guessed offsets as facts.
 */
function ioWideSpec(pointerSize: number): ViewSpec {
  const p = pointerSize === 4 ? 4 : 8;
  const names = [
    "_IO_read_ptr",
    "_IO_read_end",
    "_IO_read_base",
    "_IO_write_base",
    "_IO_write_ptr",
    "_IO_write_end",
    "_IO_buf_base",
    "_IO_buf_end",
    "_IO_save_base",
    "_IO_backup_base",
    "_IO_save_end",
  ];
  const fields = pointerFields(names, 0, p);
  let offset = names.length * p;
  fields.push(field("_IO_state", offset, 8, "bytes"));
  offset += 8;
  fields.push(field("_IO_last_state", offset, 8, "bytes"));
  offset += 8;
  // _IO_iconv_t is a pointer plus __gconv_step_data. On the usual x86_64
  // glibc ABI the embedded pair occupies 0x70 bytes, putting _wide_vtable at
  // 0xe0. Keep the 32-bit value separate because its pointer fields shrink.
  const codecvtSize = p === 8 ? 0x70 : 0x48;
  fields.push(field("_codecvt (embedded)", offset, codecvtSize, "bytes", "ABI-specific opaque codecvt state"));
  offset += codecvtSize;
  fields.push(field("_shortbuf[0]", offset, p === 8 ? 4 : 4, "bytes"));
  offset = align(offset + 4, p);
  fields.push(field("_wide_vtable", offset, p, "pointer", "struct _IO_jump_t *"));
  return { label: "_IO_wide_data", fields, expectedSize: offset + p };
}

function viewSpec(type: Exclude<ChunkViewType, "malloc_chunk">, pointerSize: number): ViewSpec {
  switch (type) {
    case "io_file": return ioFileSpec(pointerSize);
    case "io_file_plus": return ioFilePlusSpec(pointerSize);
    case "io_jump_t": return ioJumpSpec(pointerSize);
    case "io_wide_data": return ioWideSpec(pointerSize);
  }
}

function parseBigInt(value: string | undefined): bigint | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw || raw === "None" || raw === "-" || raw === "unavailable") return null;
  try {
    return BigInt(raw);
  } catch {
    try {
      return BigInt(`0x${raw.replace(/^0x/i, "")}`);
    } catch {
      return null;
    }
  }
}

function decodeHexBytes(value: string): number[] {
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
  if (row.bytes) return decodeHexBytes(row.bytes);
  const value = parseBigInt(row.value);
  if (value === null) return [];
  const bytes: number[] = [];
  for (let index = 0; index < pointerSize; index += 1) {
    bytes.push(Number((value >> BigInt(index * 8)) & 0xffn));
  }
  return bytes;
}

function payloadMemory(chunk: HeapChunk, pointerSize: number): { memory: Map<number, number>; availableSize: number } {
  const memory = new Map<number, number>();
  for (const row of dataRows(chunk)) {
    const offset = hexNumber(row.offset);
    if (!Number.isFinite(offset) || offset < 0) continue;
    rowBytes(row, pointerSize).forEach((byte, index) => memory.set(Math.trunc(offset) + index, byte));
  }
  let availableSize = 0;
  while (memory.has(availableSize)) availableSize += 1;
  return { memory, availableSize };
}

function readBytes(memory: Map<number, number>, offset: number, size: number): number[] | null {
  const result: number[] = [];
  for (let index = 0; index < size; index += 1) {
    const byte = memory.get(offset + index);
    if (byte === undefined) return null;
    result.push(byte);
  }
  return result;
}

function littleEndian(bytes: number[]): bigint {
  return bytes.reduce((value, byte, index) => value | (BigInt(byte) << BigInt(index * 8)), 0n);
}

function signedValue(value: bigint, size: number): bigint {
  const bits = BigInt(size * 8);
  const sign = 1n << (bits - 1n);
  return (value & sign) === 0n ? value : value - (1n << bits);
}

function fieldValue(spec: FieldSpec, bytes: number[]): string {
  if (spec.kind === "bytes") return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const raw = littleEndian(bytes);
  if (spec.kind === "s8" || spec.kind === "s16" || spec.kind === "s32" || spec.kind === "s64") {
    const signed = signedValue(raw, spec.size);
    return signed < 0n ? `${signed.toString()} (${formatBigInt(raw)})` : formatBigInt(raw);
  }
  return formatBigInt(raw);
}

function formatBigInt(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function pointerSizeForChunk(chunk: HeapChunk): number {
  const explicit = Number(chunk.pointerSize);
  if (explicit === 4 || explicit === 8) return explicit;
  const header = hexNumber(chunk.headerSize);
  if (header === 8 || header === 16) return header / 2;
  const row = dataRows(chunk).find((item) => item.bytes && item.bytes.length >= 8);
  if (row?.bytes) {
    const width = decodeHexBytes(row.bytes).length;
    if (width === 4 || width === 8) return width;
  }
  return 8;
}

function ioFlags(value: string, names: Array<[number, string]>): string {
  const raw = parseBigInt(value);
  if (raw === null) return "";
  const numeric = Number(raw & 0xffffffffn) >>> 0;
  const labels = names.filter(([mask]) => (numeric & mask) !== 0).map(([, label]) => label);
  if (((numeric & 0xffff0000) >>> 0) === 0xfbad0000) labels.unshift("_IO_MAGIC");
  return labels.join(" | ");
}

function fieldNote(spec: FieldSpec, value: string): string | undefined {
  if (spec.name === "_flags") {
    const summary = ioFlags(value, IO_FLAG_NAMES);
    return [spec.note, summary].filter(Boolean).join("; ") || undefined;
  }
  if (spec.name === "_flags2") {
    const summary = ioFlags(value, IO_FLAGS2_NAMES);
    return [spec.note, summary].filter(Boolean).join("; ") || undefined;
  }
  return spec.note;
}

function makeField(spec: FieldSpec, memory: Map<number, number>): ChunkViewField {
  const bytes = readBytes(memory, spec.offset, spec.size);
  const available = bytes !== null;
  const value = available ? fieldValue(spec, bytes) : "unavailable";
  const numeric = spec.kind === "pointer" && available ? parseBigInt(value) : null;
  const target = numeric !== null && numeric !== 0n ? formatBigInt(numeric) : undefined;
  const note = fieldNote(spec, value);
  return {
    name: spec.name,
    value,
    ...(target ? { target } : {}),
    offset: formatHex(spec.offset),
    size: spec.size,
    type: spec.kind,
    available,
    ...(note ? { note } : {}),
  };
}

export function reinterpretChunk(chunk: HeapChunk, type: Exclude<ChunkViewType, "malloc_chunk">): ChunkView {
  const pointerSize = pointerSizeForChunk(chunk);
  const spec = viewSpec(type, pointerSize);
  const { memory, availableSize } = payloadMemory(chunk, pointerSize);
  return {
    type,
    label: spec.label,
    fields: spec.fields.map((item) => makeField(item, memory)),
    expectedSize: spec.expectedSize,
    availableSize,
    // A chunk can be larger than the capture limit while the selected view is
    // already fully present. Only mark the interpretation truncated when a
    // field in this specific structure falls outside the captured bytes.
    truncated: availableSize < spec.expectedSize,
    pointerSize,
  };
}

export function chunkViewOption(type: ChunkViewType): ChunkViewOption {
  return CHUNK_VIEW_OPTIONS.find((option) => option.value === type) ?? CHUNK_VIEW_OPTIONS[0];
}
