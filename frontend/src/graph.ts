import ELK from "elkjs/lib/elk.bundled.js";
import { MarkerType } from "@xyflow/react";

import {
  chunkBaseAddress,
  canonicalAddress,
  dataRows,
  displayChunks,
  displayBinNames,
  fieldRows,
  parseAddress,
  searchMatches,
} from "./data";
import { reinterpretMemoryRows } from "./structViews";
import type {
  BinHeadNodeData,
  ChunkNodeData,
  GraphBuildOptions,
  GraphModel,
  HeapChunk,
  HeapEdge,
  HeapNode,
  HeapSnapshot,
  ManagementStructure,
  MemoryNodeData,
  MemoryViewRecord,
  StructureNodeData,
} from "./types";

const elk = new ELK();

const relationStyles: Record<string, { stroke: string; label: string }> = {
  fd: { stroke: "#e6a94a", label: "fd" },
  bk: { stroke: "#63c6b7", label: "bk" },
  fdNextSize: { stroke: "#f07d5d", label: "fd_nextsize" },
  bkNextSize: { stroke: "#bb8bda", label: "bk_nextsize" },
  structure: { stroke: "#66b5d8", label: "management" },
  memory: { stroke: "#b995db", label: "typed pointer" },
  head: { stroke: "#dfb35b", label: "bin head" },
};

function nodeMatches(query: string, values: string[]): boolean {
  return values.some((value) => searchMatches(value, query));
}

function binFromHead(head: string): string {
  return head === "allocated" ? "allocated" : head.replace("head", "");
}

function chunkWidth(expanded: boolean): number {
  return expanded ? 348 : 238;
}

function chunkHeight(chunk: HeapChunk, expanded: boolean): number {
  if (!expanded) return 94;
  const fieldCount = Math.min(fieldRows(chunk).length, 16);
  const payloadCount = Math.min(dataRows(chunk).length, 6);
  return 122 + fieldCount * 24 + payloadCount * 22 + (chunk.dataTruncated ? 22 : 0);
}

function structureWidth(expanded: boolean): number {
  return expanded ? 350 : 252;
}

function structureHeight(structure: ManagementStructure, expanded: boolean): number {
  return expanded ? 104 + Math.min(structure.fields.length, 16) * 23 : 82;
}

function headWidth(): number {
  return 226;
}

function memoryWidth(expanded: boolean): number {
  return expanded ? 360 : 272;
}

function memoryHeight(view: MemoryViewRecord, expanded: boolean): number {
  if (!expanded) return 96;
  const interpretation = reinterpretMemoryRows(view.data, view.type, view.pointerSize, view.dataTruncated);
  return 132 + Math.min(interpretation.fields.length, 10) * 23 + (view.error ? 30 : 0) + (interpretation.truncated ? 28 : 0);
}

function graphNodeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]/g, "_");
}

function addAddress(index: Map<string, string[]>, address: unknown, nodeId: string): void {
  const parsed = parseAddress(address);
  if (parsed === null) return;
  const key = canonicalAddress(parsed);
  const current = index.get(key) ?? [];
  if (!current.includes(nodeId)) current.push(nodeId);
  index.set(key, current);
}

function firstAddress(index: Map<string, string[]>, address: unknown): string | undefined {
  const parsed = parseAddress(address);
  if (parsed === null) return undefined;
  const key = canonicalAddress(parsed);
  return index.get(key)?.[0];
}

function edgeFor(
  id: string,
  source: string,
  target: string,
  relation: string,
  sourceHandle = "out",
  targetHandle = "in",
): HeapEdge {
  const style = relationStyles[relation] ?? relationStyles.structure;
  return {
    id,
    source,
    target,
    sourceHandle,
    targetHandle,
    type: "smoothstep",
    label: style.label,
    labelStyle: { fill: style.stroke, fontFamily: "var(--font-mono)", fontSize: 10 },
    labelBgStyle: { fill: "#101311", fillOpacity: 0.92 },
    style: { stroke: style.stroke, strokeWidth: 1.55 },
    markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke },
    data: { relation },
  };
}

export function buildGraph(snapshot: HeapSnapshot, options: GraphBuildOptions): GraphModel {
  const allChunks = displayChunks(snapshot, options.visibleBins);
  const query = options.query.trim().toLowerCase();
  const chunks = allChunks.filter(({ bin, chunk }) =>
    nodeMatches(query, [
      bin,
      chunk.index,
      chunk.address,
      chunk.chunkSize,
      chunk.fd,
      chunk.bk,
      ...fieldRows(chunk).flatMap((field) => [field.name, field.value]),
      ...dataRows(chunk).flatMap((row) => [row.offset, row.address, row.value, row.bytes ?? "", row.ascii ?? ""]),
    ]),
  );
  const structures = options.showStructures
    ? snapshot.structures.filter((structure) =>
        nodeMatches(query, [
          structure.id,
          structure.kind,
          structure.label,
          structure.address,
          ...structure.fields.flatMap((field) => [field.name, field.value]),
        ]),
      )
    : [];

  const nodes: HeapNode[] = [];
  const edges: HeapEdge[] = [];
  const chunkAddressIndex = new Map<string, string[]>();
  const structureAddressIndex = new Map<string, string[]>();
  const memoryAddressIndex = new Map<string, string[]>();
  const edgeIds = new Set<string>();

  const addEdge = (edge: HeapEdge): void => {
    if (edgeIds.has(edge.id)) return;
    edgeIds.add(edge.id);
    edges.push(edge);
  };

  for (const { id, bin, chunk } of chunks) {
    const graphId = graphNodeId(id);
    const expanded = options.expanded.has(graphId);
    const data: ChunkNodeData = {
      kind: "chunk",
      graphId,
      label: `${bin}[${chunk.index}]`,
      expanded,
      bin,
      chunk,
      onToggle: options.onToggle,
      onSelect: options.onSelect,
    };
    nodes.push({
      id: graphId,
      type: "chunk",
      data,
      position: { x: 0, y: 0 },
      style: { width: chunkWidth(expanded), height: chunkHeight(chunk, expanded) },
      draggable: true,
    });
    addAddress(chunkAddressIndex, chunk.address, graphId);
    addAddress(chunkAddressIndex, chunkBaseAddress(chunk, bin), graphId);
  }

  const visibleBinNames = new Set(displayBinNames(snapshot).filter((bin) => options.visibleBins.has(bin)));
  if (options.visibleBins.has("allocated") && (snapshot.bins.allchunks?.length ?? 0) > 0) visibleBinNames.add("allocated");

  for (const [head, address] of Object.entries(snapshot.heads)) {
    if (head === "allchunkshead") continue;
    const bin = binFromHead(head);
    const matchingChunks = chunks.filter((chunk) => chunk.bin === bin);
    const shouldShow = visibleBinNames.has(bin) &&
      (matchingChunks.length > 0 || nodeMatches(query, [head, address]));
    if (!shouldShow) continue;
    const graphId = graphNodeId(`head:${head}`);
    const data: BinHeadNodeData = {
      kind: "head",
      graphId,
      label: head,
      expanded: false,
      head,
      address,
      count: matchingChunks.length,
      onToggle: options.onToggle,
      onSelect: options.onSelect,
    };
    nodes.push({
      id: graphId,
      type: "head",
      data,
      position: { x: 0, y: 0 },
      style: { width: headWidth(), height: 58 },
      draggable: true,
    });
    const target = firstAddress(chunkAddressIndex, address);
    if (target) addEdge(edgeFor(`head:${head}->${target}`, graphId, target, "head"));
  }

  for (const structure of structures) {
    const graphId = graphNodeId(`structure:${structure.id}`);
    const expanded = options.expanded.has(graphId);
    const data: StructureNodeData = {
      kind: "structure",
      graphId,
      label: structure.label,
      expanded,
      structure,
      onToggle: options.onToggle,
      onSelect: options.onSelect,
    };
    nodes.push({
      id: graphId,
      type: "structure",
      data,
      position: { x: 0, y: 0 },
      style: { width: structureWidth(expanded), height: structureHeight(structure, expanded) },
      draggable: true,
    });
    addAddress(structureAddressIndex, structure.address, graphId);
  }

  const memoryViews = (options.memoryViews ?? []).filter((view) =>
    nodeMatches(query, [
      view.id,
      view.address,
      view.type,
      String(view.requestedSize),
      String(view.availableSize),
      ...view.data.flatMap((row) => [row.offset, row.address, row.value, row.bytes ?? "", row.ascii ?? ""]),
      ...reinterpretMemoryRows(view.data, view.type, view.pointerSize, view.dataTruncated).fields.flatMap((field) => [field.name, field.value]),
    ]),
  );

  for (const view of memoryViews) {
    const graphId = graphNodeId(view.id);
    const expanded = options.expanded.has(graphId);
    const data: MemoryNodeData = {
      kind: "memory",
      graphId,
      label: `${view.type} @ ${view.address}`,
      expanded,
      memoryView: view,
      onToggle: options.onToggle,
      onSelect: options.onSelect,
      onRemove: options.onRemoveMemoryView ?? (() => undefined),
    };
    nodes.push({
      id: graphId,
      type: "memory",
      data,
      position: { x: 0, y: 0 },
      style: { width: memoryWidth(expanded), height: memoryHeight(view, expanded) },
      draggable: true,
    });
    addAddress(memoryAddressIndex, view.address, graphId);
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const resolveTarget = (value: unknown): string | undefined => {
    const memoryTarget = firstAddress(memoryAddressIndex, value);
    if (memoryTarget && nodeIds.has(memoryTarget)) return memoryTarget;
    const structureTarget = firstAddress(structureAddressIndex, value);
    if (structureTarget && nodeIds.has(structureTarget)) return structureTarget;
    const chunkTarget = firstAddress(chunkAddressIndex, value);
    return chunkTarget && nodeIds.has(chunkTarget) ? chunkTarget : undefined;
  };

  for (const { id, chunk } of chunks) {
    const source = graphNodeId(id);
    const links: Array<[keyof HeapChunk, string]> = [
      ["fd", "fd"],
      ["bk", "bk"],
      ["fdNextSize", "fdNextSize"],
      ["bkNextSize", "bkNextSize"],
    ];
    for (const [key, relation] of links) {
      const target = resolveTarget(chunk[key]);
      if (!target) continue;
      addEdge(edgeFor(`${source}:${relation}->${target}`, source, target, relation));
    }
  }

  for (const structure of structures) {
    const source = graphNodeId(`structure:${structure.id}`);
    for (const field of structure.fields) {
      const target = resolveTarget(field.target);
      if (!target) continue;
      addEdge(edgeFor(`${source}:${field.name}->${target}`, source, target, "structure"));
    }
  }

  for (const view of memoryViews) {
    const source = graphNodeId(view.id);
    const interpretation = reinterpretMemoryRows(view.data, view.type, view.pointerSize, view.dataTruncated);
    for (const field of interpretation.fields) {
      const target = resolveTarget(field.target);
      if (!target || target === source) continue;
      addEdge(edgeFor(`${source}:${field.name}->${target}`, source, target, "memory"));
    }
  }

  return { nodes, edges, chunks, structures, memoryViews };
}

interface ElkChild {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface ElkResult {
  children?: ElkChild[];
}

export async function layoutGraph(
  nodes: HeapNode[],
  edges: HeapEdge[],
  direction: "RIGHT" | "DOWN" = "RIGHT",
  compact = false,
): Promise<HeapNode[]> {
  if (nodes.length === 0) return [];

  const graph = {
    id: "vheap",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "62",
      "elk.spacing.nodeNode": "26",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: Number(node.style?.width ?? 240),
      height: Number(node.style?.height ?? 96),
    })),
    edges: edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  };

  try {
    const result = (await elk.layout(graph)) as ElkResult;
    const positions = new Map((result.children ?? []).map((child) => [child.id, child]));
    const positioned = nodes.map((node) => {
      const position = positions.get(node.id);
      return {
        ...node,
        position: { x: position?.x ?? 0, y: position?.y ?? 0 },
        positionAbsolute: undefined,
      };
    });
    if (!compact) return positioned;

    // A phone-sized canvas cannot show ELK's disconnected component packing
    // at a useful zoom. Stack the already ordered components into one narrow
    // column so fitView keeps labels legible and the user can pan vertically.
    const order = [...positioned].sort((left, right) => {
      const leftPosition = positions.get(left.id);
      const rightPosition = positions.get(right.id);
      return (leftPosition?.y ?? 0) - (rightPosition?.y ?? 0) || (leftPosition?.x ?? 0) - (rightPosition?.x ?? 0);
    });
    let y = 0;
    const compactPositions = new Map<string, { x: number; y: number }>();
    for (const node of order) {
      compactPositions.set(node.id, { x: 0, y });
      y += Number(node.style?.height ?? 96) + 24;
    }
    return positioned.map((node) => ({ ...node, position: compactPositions.get(node.id) ?? node.position }));
  } catch {
    // A malformed/corrupted pointer graph should still leave a usable view.
    const columns = 4;
    const rowHeights: number[] = [];
    nodes.forEach((node, index) => {
      const row = Math.floor(index / columns);
      rowHeights[row] = Math.max(rowHeights[row] ?? 0, Number(node.style?.height ?? 96));
    });
    const rowOffsets: number[] = [];
    rowHeights.forEach((_height, index) => {
      rowOffsets[index] = index === 0 ? 0 : rowOffsets[index - 1] + rowHeights[index - 1] + 36;
    });
    const fallback = nodes.map((node, index) => ({
      ...node,
      position: { x: (index % columns) * 300, y: rowOffsets[Math.floor(index / columns)] ?? 0 },
    }));
    if (!compact) return fallback;
    let y = 0;
    return fallback.map((node) => {
      const result = { ...node, position: { x: 0, y } };
      y += Number(node.style?.height ?? 96) + 24;
      return result;
    });
  }
}
