import type { Edge, Node } from "@xyflow/react";

export interface HeapField {
  name: string;
  value: string;
  port?: string;
  target?: string;
}

export interface DataRow {
  offset: string;
  address: string;
  value: string;
  bytes?: string;
  ascii?: string;
}

/** A memory interpretation that can be selected for a chunk in the inspector. */
export type ChunkViewType = "malloc_chunk" | "io_file" | "io_file_plus" | "io_wide_data" | "io_jump_t";

export interface ChunkViewField extends HeapField {
  offset: string;
  size: number;
  type: string;
  available: boolean;
  note?: string;
}

export interface ChunkView {
  type: ChunkViewType;
  label: string;
  fields: ChunkViewField[];
  expectedSize: number;
  availableSize: number;
  truncated: boolean;
  pointerSize: number;
}

export interface HeapChunk {
  index: string;
  address: string;
  prevSize: string;
  chunkSize: string;
  a: string;
  m: string;
  p: string;
  fd: string;
  bk: string;
  fdNextSize?: string;
  bkNextSize?: string;
  headerSize?: string;
  fields?: HeapField[];
  data?: DataRow[];
  dataAddress?: string;
  dataSize?: string;
  pointerSize?: number;
  dataTruncated?: boolean;
  dataDisabled?: boolean;
  [key: string]: unknown;
}

export interface ManagementStructure {
  id: string;
  kind: string;
  label: string;
  address: string;
  source?: string;
  fields: HeapField[];
}

export interface HeapSnapshot {
  version?: number;
  pointerSize?: number;
  heads: Record<string, string>;
  bins: Record<string, HeapChunk[]>;
  structures: ManagementStructure[];
}

export type LayoutDirection = "RIGHT" | "DOWN";
export type SidebarTab = "bins" | "structures";

export interface BaseGraphData extends Record<string, unknown> {
  kind: "head" | "chunk" | "structure";
  graphId: string;
  label: string;
  expanded: boolean;
  onToggle: (graphId: string) => void;
  onSelect: (graphId: string) => void;
}

export interface BinHeadNodeData extends BaseGraphData {
  kind: "head";
  head: string;
  address: string;
  count: number;
}

export interface ChunkNodeData extends BaseGraphData {
  kind: "chunk";
  bin: string;
  chunk: HeapChunk;
}

export interface StructureNodeData extends BaseGraphData {
  kind: "structure";
  structure: ManagementStructure;
}

export type GraphNodeData = BinHeadNodeData | ChunkNodeData | StructureNodeData;
export type HeapNode = Node<GraphNodeData>;
export type HeapEdge = Edge<{ relation: string }>;

export interface DisplayChunk {
  id: string;
  bin: string;
  chunk: HeapChunk;
}

export interface GraphBuildOptions {
  visibleBins: Set<string>;
  showStructures: boolean;
  query: string;
  expanded: Set<string>;
  onToggle: (graphId: string) => void;
  onSelect: (graphId: string) => void;
}

export interface GraphModel {
  nodes: HeapNode[];
  edges: HeapEdge[];
  chunks: DisplayChunk[];
  structures: ManagementStructure[];
}

export type SelectedItem =
  | { kind: "chunk"; id: string; bin: string; chunk: HeapChunk }
  | { kind: "structure"; id: string; structure: ManagementStructure }
  | { kind: "head"; id: string; head: string; address: string; count: number };
