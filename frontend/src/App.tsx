import {
  Activity,
  AlertTriangle,
  Binary,
  Boxes,
  Check,
  Columns3,
  Eye,
  EyeOff,
  Filter,
  Gauge,
  LayoutDashboard,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SplitSquareHorizontal,
  Workflow,
  X,
} from "lucide-react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import { io, type Socket } from "socket.io-client";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { BinHeadNode } from "./BinHeadNode";
import { ChunkNode } from "./ChunkNode";
import {
  canonicalAddress,
  demoSnapshot,
  displayBinNames,
  displayChunks,
  isRecord,
  memoryViewId,
  normaliseMemoryView,
  parseAddress,
  parseSnapshot,
  readSnapshotMemory,
} from "./data";
import { buildGraph, layoutGraph } from "./graph";
import { Inspector } from "./Inspector";
import { MemoryNode } from "./MemoryNode";
import { MemoryRegionView } from "./MemoryRegionView";
import { StructureNode } from "./StructureNode";
import { MEMORY_VIEW_OPTIONS, isTypedMemoryView, memoryViewExpectedSize, memoryViewOption } from "./structViews";
import type { HeapEdge, HeapNode, HeapSnapshot, MemoryViewRecord, MemoryViewType, SelectedItem } from "./types";

const nodeTypes: NodeTypes = {
  chunk: ChunkNode,
  structure: StructureNode,
  head: BinHeadNode,
  memory: MemoryNode,
};

const DEMO_MODE = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("demo") === "1";
const EMPTY_SNAPSHOT: HeapSnapshot = { heads: {}, bins: {}, structures: [] };
const MAX_MEMORY_VIEW_BYTES = 0x10000;
const MEMORY_REQUEST_TIMEOUT_MS = 10000;

interface PendingMemoryRequest {
  id: string;
  address: string;
  type: MemoryViewType;
  name?: string;
  requestedSize: number;
  select: boolean;
  timer: number;
}

function setEquals(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function itemFromNode(node: HeapNode | undefined): SelectedItem | null {
  if (!node) return null;
  if (node.data.kind === "chunk") return { kind: "chunk", id: node.id, bin: node.data.bin, chunk: node.data.chunk };
  if (node.data.kind === "structure") return { kind: "structure", id: node.id, structure: node.data.structure };
  if (node.data.kind === "memory") return { kind: "memory", id: node.id, memoryView: node.data.memoryView };
  return { kind: "head", id: node.id, head: node.data.head, address: node.data.address, count: node.data.count };
}

function formatAge(date: Date | null): string {
  if (!date) return "never";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function memoryViewName(view: MemoryViewRecord): string {
  return view.name?.trim() || memoryViewOption(view.type).label;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<HeapSnapshot>(() => DEMO_MODE ? demoSnapshot() : EMPTY_SNAPSHOT);
  const [visibleBins, setVisibleBins] = useState<Set<string>>(() => new Set(DEMO_MODE ? [...displayBinNames(demoSnapshot()), "allocated"] : []));
  const [showStructures, setShowStructures] = useState(true);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [direction, setDirection] = useState<"RIGHT" | "DOWN">(() => typeof window !== "undefined" && window.innerWidth < 700 ? "DOWN" : "RIGHT");
  const [nodes, setNodes] = useState<HeapNode[]>([]);
  const [edges, setEdges] = useState<HeapEdge[]>([]);
  const [connected, setConnected] = useState(DEMO_MODE);
  const [live, setLive] = useState(!DEMO_MODE);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(DEMO_MODE ? new Date() : null);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [compactLayout, setCompactLayout] = useState(() => typeof window !== "undefined" && window.innerWidth < 700);
  const [memoryViews, setMemoryViews] = useState<MemoryViewRecord[]>([]);
  const [memoryAddressInput, setMemoryAddressInput] = useState("");
  const [memoryNameInput, setMemoryNameInput] = useState("");
  const [memoryTypeInput, setMemoryTypeInput] = useState<MemoryViewType>("raw_memory");
  const [memorySizeInput, setMemorySizeInput] = useState("");
  const [memoryFormError, setMemoryFormError] = useState<string | null>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [memoryPanelViewId, setMemoryPanelViewId] = useState<string | null>(null);
  const pointerSize = snapshot.pointerSize === 4 ? 4 : 8;
  const socketRef = useRef<Socket | null>(null);
  const lastPayloadRef = useRef<string>("");
  const flowRef = useRef<ReactFlowInstance<HeapNode, HeapEdge> | null>(null);
  const snapshotRef = useRef<HeapSnapshot>(snapshot);
  const observedSnapshotRef = useRef<HeapSnapshot>(snapshot);
  const pointerSizeRef = useRef(pointerSize);
  const memoryViewsRef = useRef<MemoryViewRecord[]>([]);
  const pendingMemoryRequests = useRef(new Map<string, PendingMemoryRequest>());
  const memoryRequestSequence = useRef(0);
  const memoryAddressRef = useRef<HTMLInputElement | null>(null);
  const deferredQuery = useDeferredValue(query);

  const selectedMemoryExpectedSize = memoryViewExpectedSize(memoryTypeInput, pointerSize);

  useEffect(() => {
    snapshotRef.current = snapshot;
    pointerSizeRef.current = pointerSize;
  }, [pointerSize, snapshot]);

  useEffect(() => {
    memoryViewsRef.current = memoryViews;
  }, [memoryViews]);

  useEffect(() => {
    if (memoryViews.length === 0) {
      if (memoryPanelViewId !== null) setMemoryPanelViewId(null);
      if (memoryPanelOpen) setMemoryPanelOpen(false);
      return;
    }
    if (!memoryPanelViewId || !memoryViews.some((view) => view.id === memoryPanelViewId)) {
      setMemoryPanelViewId(memoryViews[0].id);
    }
  }, [memoryPanelOpen, memoryPanelViewId, memoryViews]);

  const upsertMemoryView = useCallback((record: MemoryViewRecord) => {
    setMemoryViews((previous) => {
      const index = previous.findIndex((view) => view.id === record.id);
      if (index < 0) return [...previous, record];
      const next = [...previous];
      next[index] = record;
      return next;
    });
  }, []);

  const selectNode = useCallback((id: string) => {
    setSelectedId(id);
    setInspectorOpen(true);
    if (id.startsWith("memory:") || memoryViewsRef.current.some((view) => view.id === id)) {
      setMemoryPanelViewId(id);
      setMemoryPanelOpen(true);
    }
  }, []);

  const markMemoryRequestError = useCallback((requestId: string, message: string) => {
    const pending = pendingMemoryRequests.current.get(requestId);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingMemoryRequests.current.delete(requestId);
    setMemoryBusy(pendingMemoryRequests.current.size > 0);
    setMemoryViews((previous) => previous.map((view) => view.id === pending.id ? {
      ...view,
      ...(pending.name ? { name: pending.name } : {}),
      address: pending.address,
      type: pending.type,
      pointerSize: pointerSizeRef.current,
      requestedSize: pending.requestedSize,
      availableSize: 0,
      data: [],
      dataTruncated: true,
      source: "gdb",
      error: message,
    } : view));
    if (pending.select) selectNode(pending.id);
  }, [selectNode]);

  const handleMemoryData = useCallback((payload: unknown) => {
    if (!isRecord(payload)) return;
    const requestId = String(payload.requestId ?? "");
    const pending = pendingMemoryRequests.current.get(requestId);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingMemoryRequests.current.delete(requestId);
    setMemoryBusy(pendingMemoryRequests.current.size > 0);
    const response = {
      ...payload,
      id: pending.id,
      name: payload.name ?? pending.name,
      address: payload.address ?? pending.address,
      type: payload.type ?? pending.type,
      pointerSize: payload.pointerSize ?? pointerSizeRef.current,
      requestedSize: payload.requestedSize ?? pending.requestedSize,
    };
    const record = normaliseMemoryView(response, pending.type);
    if (!record) {
      setMemoryViews((previous) => previous.map((view) => view.id === pending.id ? {
        ...view,
        error: "invalid memory response from GDB",
        dataTruncated: true,
      } : view));
      if (pending.select) selectNode(pending.id);
      return;
    }
    upsertMemoryView(record);
    if (pending.select) selectNode(record.id);
  }, [selectNode, upsertMemoryView]);

  const requestMemoryView = useCallback((addressInput: string, type: MemoryViewType, requestedSize: number, select = true, replaceId?: string, name?: string) => {
    const parsedAddress = parseAddress(addressInput);
    if (parsedAddress === null) {
      setMemoryFormError("enter a hexadecimal or decimal address");
      return;
    }
    if (!Number.isInteger(requestedSize) || requestedSize < 1 || requestedSize > MAX_MEMORY_VIEW_BYTES) {
      setMemoryFormError(`read size must be between 1 and ${MAX_MEMORY_VIEW_BYTES} bytes`);
      return;
    }
    const address = canonicalAddress(parsedAddress);
    const id = replaceId ?? memoryViewId(address, type);
    const existingView = replaceId ? memoryViewsRef.current.find((view) => view.id === replaceId) : undefined;
    const viewName = name?.trim() || existingView?.name?.trim() || undefined;

    if (DEMO_MODE) {
      const read = readSnapshotMemory(snapshotRef.current, parsedAddress, requestedSize);
      upsertMemoryView({
        id,
        ...(viewName ? { name: viewName } : {}),
        address,
        type,
        pointerSize: read.pointerSize,
        requestedSize,
        availableSize: read.availableSize,
        data: read.rows,
        dataTruncated: read.availableSize < requestedSize,
        source: "demo",
        ...(read.availableSize === 0 ? { error: "address is outside the captured demo memory" } : {}),
      });
      setMemoryFormError(null);
      if (select) selectNode(id);
      return;
    }

    const socket = socketRef.current;
    if (!socket || !socket.connected) {
      setMemoryFormError("GDB socket is not connected");
      return;
    }
    const existingRequest = [...pendingMemoryRequests.current.values()].find((request) => request.id === id);
    if (existingRequest) {
      if (select) selectNode(id);
      return;
    }
    const requestId = `memory-${Date.now().toString(36)}-${(memoryRequestSequence.current += 1).toString(36)}`;
    const pending: PendingMemoryRequest = {
      id,
      address,
      type,
      ...(viewName ? { name: viewName } : {}),
      requestedSize,
      select,
      timer: window.setTimeout(() => {
        markMemoryRequestError(requestId, "timed out waiting for GDB to read memory");
      }, MEMORY_REQUEST_TIMEOUT_MS),
    };
    pendingMemoryRequests.current.set(requestId, pending);
    setMemoryBusy(true);
    upsertMemoryView({
      id,
      ...(viewName ? { name: viewName } : {}),
      address,
      type,
      pointerSize: pointerSizeRef.current,
      requestedSize,
      availableSize: 0,
      data: [],
      dataTruncated: true,
      source: "gdb",
    });
    setMemoryFormError(null);
    if (select) selectNode(id);
    socket.emit("readMemory", { requestId, address, type, size: requestedSize, ...(viewName ? { name: viewName } : {}) });
  }, [markMemoryRequestError, selectNode, upsertMemoryView]);

  const removeMemoryView = useCallback((id: string) => {
    setMemoryViews((previous) => previous.filter((view) => view.id !== id));
    setSelectedId((current) => current === id || current === `memory_${id}` ? null : current);
    for (const [requestId, request] of pendingMemoryRequests.current.entries()) {
      if (request.id === id) {
        window.clearTimeout(request.timer);
        pendingMemoryRequests.current.delete(requestId);
      }
    }
    setMemoryBusy(pendingMemoryRequests.current.size > 0);
  }, []);

  const renameMemoryView = useCallback((id: string, name: string) => {
    setMemoryViews((previous) => previous.map((view) => {
      if (view.id !== id) return view;
      const trimmed = name.trim();
      return trimmed ? { ...view, name: trimmed } : (() => {
        const { name: _name, ...withoutName } = view;
        return withoutName;
      })();
    }));
  }, []);

  const refreshMemoryViews = useCallback(() => {
    for (const view of memoryViewsRef.current) {
      if ([...pendingMemoryRequests.current.values()].some((request) => request.id === view.id)) continue;
      requestMemoryView(view.address, view.type, view.requestedSize, false, view.id);
    }
  }, [requestMemoryView]);

  useEffect(() => {
    if (observedSnapshotRef.current === snapshot) return;
    observedSnapshotRef.current = snapshot;
    refreshMemoryViews();
  }, [refreshMemoryViews, snapshot]);

  useEffect(() => {
    const updateLayoutMode = () => setCompactLayout(window.innerWidth < 700);
    window.addEventListener("resize", updateLayoutMode);
    return () => window.removeEventListener("resize", updateLayoutMode);
  }, []);

  const binNames = useMemo(() => displayBinNames(snapshot), [snapshot]);
  const allBinNames = useMemo(() => [...binNames, ...(snapshot.bins.allchunks ? ["allocated"] : [])], [binNames, snapshot.bins.allchunks]);

  useEffect(() => {
    setVisibleBins((previous) => {
      const next = new Set([...previous].filter((name) => allBinNames.includes(name)));
      if (next.size === 0 && allBinNames.length > 0) allBinNames.forEach((name) => next.add(name));
      return setEquals(previous, next) ? previous : next;
    });
  }, [allBinNames]);

  const receiveSnapshot = useCallback((payload: unknown) => {
    try {
      const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
      if (raw === lastPayloadRef.current) return;
      lastPayloadRef.current = raw;
      setSnapshot(parseSnapshot(payload));
      setLastUpdate(new Date());
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to parse heap snapshot");
    }
  }, []);

  useEffect(() => {
    if (DEMO_MODE) return;
    const socket = io({ path: "/socket.io", transports: ["websocket", "polling"] });
    socketRef.current = socket;
    socket.on("connect", () => {
      setConnected(true);
      setError(null);
      socket.emit("getHeap", "");
      refreshMemoryViews();
    });
    socket.on("disconnect", () => {
      setConnected(false);
      for (const requestId of [...pendingMemoryRequests.current.keys()]) {
        markMemoryRequestError(requestId, "GDB socket disconnected before memory was read");
      }
    });
    socket.on("connect_error", (reason) => setError(reason.message || "Socket.IO connection failed"));
    socket.on("heapData", receiveSnapshot);
    socket.on("memoryData", handleMemoryData);
    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      for (const request of pendingMemoryRequests.current.values()) window.clearTimeout(request.timer);
      pendingMemoryRequests.current.clear();
      setMemoryBusy(false);
      setConnected(false);
    };
  }, [handleMemoryData, markMemoryRequestError, receiveSnapshot, refreshMemoryViews]);

  useEffect(() => {
    if (DEMO_MODE || !live) return;
    const timer = window.setInterval(() => socketRef.current?.emit("getHeap", ""), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  const refresh = useCallback(() => {
    if (DEMO_MODE) {
      setSnapshot(demoSnapshot());
      setLastUpdate(new Date());
      return;
    }
    socketRef.current?.emit("getHeap", "");
  }, []);

  const submitMemoryView = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = parseAddress(memoryAddressInput);
    if (address === null) {
      setMemoryFormError("enter a hexadecimal or decimal address");
      return;
    }
    let requestedSize = selectedMemoryExpectedSize;
    if (memorySizeInput.trim()) {
      const parsedSize = parseAddress(memorySizeInput);
      if (parsedSize === null || parsedSize < 1n || parsedSize > BigInt(MAX_MEMORY_VIEW_BYTES)) {
        setMemoryFormError(`read size must be between 1 and ${MAX_MEMORY_VIEW_BYTES} bytes`);
        return;
      }
      requestedSize = Number(parsedSize);
    }
    requestMemoryView(canonicalAddress(address), memoryTypeInput, requestedSize, true, undefined, memoryNameInput.trim() || undefined);
  }, [memoryAddressInput, memoryNameInput, memorySizeInput, memoryTypeInput, requestMemoryView, selectedMemoryExpectedSize]);

  const toggleNode = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const graphModel = useMemo(() => buildGraph(snapshot, {
    visibleBins,
    showStructures,
    memoryViews,
    query: deferredQuery,
    expanded,
    onToggle: toggleNode,
    onSelect: selectNode,
    onRemoveMemoryView: removeMemoryView,
  }), [snapshot, visibleBins, showStructures, memoryViews, deferredQuery, expanded, toggleNode, selectNode, removeMemoryView]);

  const selected = useMemo(() => {
    const graphNode = graphModel.nodes.find((node) => node.id === selectedId);
    return itemFromNode(graphNode);
  }, [graphModel, selectedId]);

  const activeMemoryView = useMemo(() => {
    if (memoryPanelViewId) {
      const selectedView = memoryViews.find((view) => view.id === memoryPanelViewId);
      if (selectedView) return selectedView;
    }
    if (selected?.kind === "memory") return selected.memoryView;
    return memoryViews[0] ?? null;
  }, [memoryPanelViewId, memoryViews, selected]);

  const refreshActiveMemoryView = useCallback(() => {
    if (!activeMemoryView) return;
    requestMemoryView(activeMemoryView.address, activeMemoryView.type, activeMemoryView.requestedSize, false, activeMemoryView.id);
  }, [activeMemoryView, requestMemoryView]);

  useEffect(() => {
    let active = true;
    layoutGraph(graphModel.nodes, graphModel.edges, direction, compactLayout).then((positioned) => {
      if (!active) return;
      setNodes(positioned);
      setEdges(graphModel.edges);
      window.requestAnimationFrame(() => {
        if (compactLayout) {
          void flowRef.current?.setViewport({ x: 22, y: 18, zoom: 0.68 }, { duration: 260 });
        } else {
          void flowRef.current?.fitView({ padding: 0.18, duration: 260 });
        }
      });
    });
    return () => { active = false; };
  }, [graphModel, direction, compactLayout]);

  const toggleBin = (name: string) => {
    setVisibleBins((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const clearFilters = () => {
    setQuery("");
    setVisibleBins(new Set(allBinNames));
    setShowStructures(true);
  };

  const onNodesChange = useCallback((changes: NodeChange<HeapNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current) as HeapNode[]);
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange<HeapEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current) as HeapEdge[]);
  }, []);

  const visibleChunkCount = graphModel.chunks.length;
  const totalChunkCount = useMemo(() => displayChunks(snapshot, new Set([...allBinNames])).length, [snapshot, allBinNames]);
  const hasFilters = query.trim().length > 0 || visibleBins.size !== allBinNames.length || !showStructures;
  const structureCount = snapshot.structures.length;
  const structureStatus = !DEMO_MODE && !connected
    ? "waiting for snapshot"
    : snapshot.structuresEnabled === false
      ? "collection disabled"
      : structureCount > 0
        ? `${structureCount} reported`
        : "none reported";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Workflow size={19} /></div>
          <div><div className="brand-name">vHeap<span>/</span>view</div><div className="brand-caption">ptmalloc memory topology</div></div>
        </div>
        <div className="topbar-stats">
          <div className="stat"><span>visible</span><strong>{visibleChunkCount}</strong><small>/ {totalChunkCount}</small></div>
          <div className="stat"><span>structures</span><strong>{graphModel.structures.length}</strong></div>
          <div className="stat"><span>memory views</span><strong>{memoryViews.length}</strong></div>
          <div className={`connection ${connected ? "is-online" : "is-offline"}`}><span className="status-dot" />{DEMO_MODE ? "demo" : connected ? "live" : "offline"}</div>
        </div>
        <div className="topbar-actions">
          <button className="icon-button" type="button" onClick={() => setSidebarOpen((open) => !open)} title="Toggle filters" aria-label="Toggle filters"><Filter size={16} /></button>
          <button className="icon-button" type="button" onClick={() => setInspectorOpen((open) => !open)} title="Toggle inspector" aria-label="Toggle inspector"><Columns3 size={16} /></button>
          <button className="refresh-button" type="button" onClick={refresh}><RefreshCw size={14} /> refresh</button>
        </div>
      </header>

      <div className="workspace">
        <aside className={`filter-sidebar ${sidebarOpen ? "is-open" : ""}`}>
          <div className="sidebar-heading"><div><span className="eyebrow">CONTROL ROOM</span><h1>Heap map</h1></div><button className="icon-button mobile-close" type="button" onClick={() => setSidebarOpen(false)} title="Close filters" aria-label="Close filters"><X size={16} /></button></div>
          <div className="search-wrap"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search address, field, bin" aria-label="Search heap" />{query && <button className="search-clear" type="button" onClick={() => setQuery("")} title="Clear search" aria-label="Clear search"><X size={13} /></button>}</div>

          <section className="sidebar-section">
            <div className="section-heading"><span>bin families</span><span className="section-count">{visibleBins.size}/{allBinNames.length}</span></div>
            <div className="bin-list">
              {allBinNames.map((name) => {
                const count = name === "allocated" ? displayChunks(snapshot, new Set(["allocated"])).length : snapshot.bins[name]?.length ?? 0;
                const checked = visibleBins.has(name);
                return <label className={`bin-option ${checked ? "is-checked" : ""}`} key={name}><input type="checkbox" checked={checked} onChange={() => toggleBin(name)} /><span className="checkbox-mark"><Check size={12} /></span><span className="bin-name">{name}</span><span className="bin-count">{count}</span></label>;
              })}
              {allBinNames.length === 0 && <div className="empty-sidebar">No bins in current snapshot</div>}
            </div>
          </section>

          <section className="sidebar-section" aria-labelledby="allocator-structures-heading">
            <div className="section-heading"><span id="allocator-structures-heading">allocator structures</span><button className="text-button" type="button" onClick={() => setShowStructures((show) => !show)} aria-pressed={showStructures} aria-label={`${showStructures ? "Hide" : "Show"} allocator structures`}>{showStructures ? <Eye size={13} /> : <EyeOff size={13} />}{showStructures ? "shown" : "hidden"}</button></div>
            <button id="allocator-structures-toggle" className={`structure-toggle ${showStructures ? "is-on" : ""}`} type="button" onClick={() => setShowStructures((show) => !show)} aria-pressed={showStructures} aria-label={`${showStructures ? "Hide" : "Show"} allocator structures`}><span className="toggle-track" aria-hidden="true"><span /></span><span className="structure-toggle-label">malloc_state / heap_info / tcache</span><b aria-live="polite">{structureCount}</b></button>
            <div className={`structures-status ${structureCount > 0 ? "has-structures" : ""}`} role="status">{structureStatus}</div>
          </section>

          <section className="sidebar-section memory-section">
            <div className="section-heading"><span><Binary size={13} /> memory views</span><span className="section-count">{memoryViews.length}</span></div>
            <form className="memory-form" onSubmit={submitMemoryView}>
              <label className="memory-form-label" htmlFor="memory-address">address</label>
              <input ref={memoryAddressRef} id="memory-address" className="memory-input" value={memoryAddressInput} onChange={(event) => setMemoryAddressInput(event.target.value)} placeholder="0x7ffff7dd18c0" spellCheck={false} autoComplete="off" />
              <label className="memory-form-label" htmlFor="memory-name">name <span>(optional)</span></label>
              <input id="memory-name" className="memory-input" value={memoryNameInput} onChange={(event) => setMemoryNameInput(event.target.value)} placeholder="e.g. stdout_file" spellCheck={false} autoComplete="off" />
              <label className="memory-form-label" htmlFor="memory-type">interpretation <span>(optional)</span></label>
              <select id="memory-type" className="memory-input" value={memoryTypeInput} onChange={(event) => setMemoryTypeInput(event.target.value as MemoryViewType)}>
                {MEMORY_VIEW_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <label className="memory-form-label" htmlFor="memory-size">read bytes <span>(optional)</span></label>
              <input id="memory-size" className="memory-input" value={memorySizeInput} onChange={(event) => setMemorySizeInput(event.target.value)} placeholder={String(selectedMemoryExpectedSize)} inputMode="text" spellCheck={false} />
              <div className="memory-form-meta">{isTypedMemoryView(memoryTypeInput) ? `layout ${selectedMemoryExpectedSize} B` : `raw page ${selectedMemoryExpectedSize} B`} · {pointerSize * 8}-bit target</div>
              {memoryFormError && <div className="memory-form-error"><AlertTriangle size={12} /><span>{memoryFormError}</span></div>}
              <button className="memory-submit" type="submit" disabled={memoryBusy && !DEMO_MODE}><Plus size={14} />{memoryBusy ? "reading..." : isTypedMemoryView(memoryTypeInput) ? "parse address" : "open dump"}</button>
            </form>
            {memoryViews.length > 0 && <div className="memory-view-list">
              {memoryViews.map((view) => (
                <div className="memory-view-item" key={view.id}>
                  <button type="button" className="memory-view-select" onClick={() => selectNode(view.id)} title="Select memory view">
                    <span className="memory-view-type">{memoryViewName(view)}</span><code>{memoryViewOption(view.type).label} · {view.address}</code><small>{view.availableSize}/{view.requestedSize} B</small>
                  </button>
                  <button type="button" className="mini-icon memory-view-remove" onClick={() => removeMemoryView(view.id)} title="Remove memory view" aria-label={`Remove ${memoryViewName(view)} at ${view.address}`}><X size={12} /></button>
                </div>
              ))}
            </div>}
          </section>

          <section className="sidebar-section layout-section">
            <div className="section-heading"><span>layout</span><Settings2 size={13} /></div>
            <div className="segmented"><button className={direction === "RIGHT" ? "is-active" : ""} type="button" onClick={() => setDirection("RIGHT")}><SplitSquareHorizontal size={14} /> flow</button><button className={direction === "DOWN" ? "is-active" : ""} type="button" onClick={() => setDirection("DOWN")}><LayoutDashboard size={14} /> stack</button></div>
          </section>

          {hasFilters && <button className="clear-filters" type="button" onClick={clearFilters}><RefreshCw size={13} /> reset filters</button>}

          <div className="sidebar-footer"><div className="footer-line"><span className="status-dot" /> snapshot {formatAge(lastUpdate)}</div><div className="footer-line muted"><Gauge size={12} /> bounded payload view</div></div>
        </aside>

        <main className="canvas-shell">
          <div className="canvas-toolbar">
            <div className="toolbar-title"><Activity size={15} /><span>{query ? `matching "${query}"` : "allocator graph"}</span></div>
            <div className="toolbar-actions">
              <button
                className={`live-button memory-panel-toggle ${memoryPanelOpen ? "is-live" : ""}`}
                type="button"
                onClick={() => {
                  if (memoryViews.length === 0) {
                    setSidebarOpen(true);
                    window.requestAnimationFrame(() => memoryAddressRef.current?.focus());
                    return;
                  }
                  if (!memoryPanelViewId && memoryViews[0]) setMemoryPanelViewId(memoryViews[0].id);
                  setMemoryPanelOpen((open) => !open);
                }}
                title={memoryViews.length === 0 ? "Open memory view form" : memoryPanelOpen ? "Hide memory region" : "Show memory region"}
                aria-label={memoryViews.length === 0 ? "Open memory view form" : memoryPanelOpen ? "Hide memory region" : "Show memory region"}
              >
                <Binary size={13} /> memory
              </button>
              <button className={`live-button ${live ? "is-live" : ""}`} type="button" disabled={DEMO_MODE} onClick={() => setLive((value) => !value)}>{live ? <Pause size={13} /> : <Play size={13} />}{DEMO_MODE ? "demo" : live ? "polling" : "paused"}</button>
            </div>
          </div>
          {error && <div className="error-banner"><AlertTriangle size={15} /><span>{error}</span><button type="button" onClick={() => setError(null)} title="Dismiss" aria-label="Dismiss error"><X size={14} /></button></div>}
          <div className="flow-stage">
            {nodes.length === 0 ? <div className="canvas-empty"><Boxes size={28} /><h2>{query ? "No matching nodes" : connected || DEMO_MODE ? "Heap snapshot is empty" : "Waiting for heap data"}</h2><p>{query ? "No nodes match the current filter." : "No allocator nodes reported."}</p></div> : (
              /* Keep management nodes mounted while Edge is measuring the canvas. */
              <ReactFlow<HeapNode, HeapEdge>
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={(_event, node) => selectNode(node.id)}
                onInit={(instance) => {
                  flowRef.current = instance;
                  if (compactLayout) void instance.setViewport({ x: 22, y: 18, zoom: 0.68 });
                  else void instance.fitView({ padding: 0.18 });
                }}
                fitView
                minZoom={0.1}
                maxZoom={2.2}
                proOptions={{ hideAttribution: true }}
                nodesDraggable
                nodesConnectable={false}
                panOnScroll
                selectionOnDrag={false}
              >
                <Background variant={BackgroundVariant.Dots} color="#2a3532" gap={24} size={1} />
                <Controls showInteractive={false} position="bottom-left" />
                <MiniMap position="bottom-right" pannable zoomable nodeColor={(node) => node.type === "structure" ? "#5faec3" : node.type === "memory" ? "#b995db" : node.type === "head" ? "#d49b43" : "#668f7b"} maskColor="rgba(8, 12, 11, 0.72)" />
                <Panel position="top-right" className="graph-legend"><span className="legend-item"><i className="legend-swatch chunk" /> chunk</span><span className="legend-item"><i className="legend-swatch structure" /> structure</span><span className="legend-item"><i className="legend-swatch memory" /> memory</span><span className="legend-item"><i className="legend-swatch pointer" /> pointer</span></Panel>
              </ReactFlow>
            )}
          </div>
          {memoryPanelOpen && activeMemoryView && (
            <MemoryRegionView
              view={activeMemoryView}
              views={memoryViews}
              busy={memoryBusy}
              onSelectView={(id) => selectNode(id)}
              onNavigate={(address) => requestMemoryView(address, activeMemoryView.type, activeMemoryView.requestedSize, true, activeMemoryView.id)}
              onRefresh={refreshActiveMemoryView}
              onClose={() => setMemoryPanelOpen(false)}
            />
          )}
        </main>

        {inspectorOpen && <Inspector item={selected} onClose={() => { setInspectorOpen(false); setSelectedId(null); }} onRemoveMemoryView={removeMemoryView} onRenameMemoryView={renameMemoryView} />}
      </div>
      {!sidebarOpen && <button className="mobile-filter-fab" type="button" onClick={() => setSidebarOpen(true)} title="Open filters" aria-label="Open filters"><Filter size={17} /></button>}
    </div>
  );
}
