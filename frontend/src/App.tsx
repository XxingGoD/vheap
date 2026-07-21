import {
  Activity,
  AlertTriangle,
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
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { BinHeadNode } from "./BinHeadNode";
import { ChunkNode } from "./ChunkNode";
import { demoSnapshot, displayBinNames, displayChunks, parseSnapshot } from "./data";
import { buildGraph, layoutGraph } from "./graph";
import { Inspector } from "./Inspector";
import { StructureNode } from "./StructureNode";
import type { HeapEdge, HeapNode, HeapSnapshot, SelectedItem } from "./types";

const nodeTypes: NodeTypes = {
  chunk: ChunkNode,
  structure: StructureNode,
  head: BinHeadNode,
};

const DEMO_MODE = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("demo") === "1";
const EMPTY_SNAPSHOT: HeapSnapshot = { heads: {}, bins: {}, structures: [] };

function setEquals(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function itemFromNode(node: HeapNode | undefined): SelectedItem | null {
  if (!node) return null;
  if (node.data.kind === "chunk") return { kind: "chunk", id: node.id, bin: node.data.bin, chunk: node.data.chunk };
  if (node.data.kind === "structure") return { kind: "structure", id: node.id, structure: node.data.structure };
  return { kind: "head", id: node.id, head: node.data.head, address: node.data.address, count: node.data.count };
}

function formatAge(date: Date | null): string {
  if (!date) return "never";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
  const socketRef = useRef<Socket | null>(null);
  const lastPayloadRef = useRef<string>("");
  const flowRef = useRef<ReactFlowInstance<HeapNode, HeapEdge> | null>(null);
  const deferredQuery = useDeferredValue(query);

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
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (reason) => setError(reason.message || "Socket.IO connection failed"));
    socket.on("heapData", receiveSnapshot);
    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [receiveSnapshot]);

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

  const toggleNode = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectNode = useCallback((id: string) => {
    setSelectedId(id);
    setInspectorOpen(true);
  }, []);

  const graphModel = useMemo(() => buildGraph(snapshot, {
    visibleBins,
    showStructures,
    query: deferredQuery,
    expanded,
    onToggle: toggleNode,
    onSelect: selectNode,
  }), [snapshot, visibleBins, showStructures, deferredQuery, expanded, toggleNode, selectNode]);

  const selected = useMemo(() => {
    const graphNode = graphModel.nodes.find((node) => node.id === selectedId);
    return itemFromNode(graphNode);
  }, [graphModel, selectedId]);

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

          <section className="sidebar-section">
            <div className="section-heading"><span>allocator structures</span><button className="text-button" type="button" onClick={() => setShowStructures((show) => !show)}>{showStructures ? <Eye size={13} /> : <EyeOff size={13} />}{showStructures ? "shown" : "hidden"}</button></div>
            <button className={`structure-toggle ${showStructures ? "is-on" : ""}`} type="button" onClick={() => setShowStructures((show) => !show)}><span className="toggle-track"><span /></span><span>malloc_state / heap_info / tcache</span><b>{snapshot.structures.length}</b></button>
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
            <div className="toolbar-actions"><button className={`live-button ${live ? "is-live" : ""}`} type="button" disabled={DEMO_MODE} onClick={() => setLive((value) => !value)}>{live ? <Pause size={13} /> : <Play size={13} />}{DEMO_MODE ? "demo" : live ? "polling" : "paused"}</button></div>
          </div>
          {error && <div className="error-banner"><AlertTriangle size={15} /><span>{error}</span><button type="button" onClick={() => setError(null)} title="Dismiss" aria-label="Dismiss error"><X size={14} /></button></div>}
          <div className="flow-stage">
            {nodes.length === 0 ? <div className="canvas-empty"><Boxes size={28} /><h2>{query ? "No matching nodes" : connected || DEMO_MODE ? "Heap snapshot is empty" : "Waiting for heap data"}</h2><p>{query ? "No nodes match the current filter." : "No allocator nodes reported."}</p></div> : (
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
                onlyRenderVisibleElements
                proOptions={{ hideAttribution: true }}
                nodesDraggable
                nodesConnectable={false}
                panOnScroll
                selectionOnDrag={false}
              >
                <Background variant={BackgroundVariant.Dots} color="#2a3532" gap={24} size={1} />
                <Controls showInteractive={false} position="bottom-left" />
                <MiniMap position="bottom-right" pannable zoomable nodeColor={(node) => node.type === "structure" ? "#5faec3" : node.type === "head" ? "#d49b43" : "#668f7b"} maskColor="rgba(8, 12, 11, 0.72)" />
                <Panel position="top-right" className="graph-legend"><span className="legend-item"><i className="legend-swatch chunk" /> chunk</span><span className="legend-item"><i className="legend-swatch structure" /> structure</span><span className="legend-item"><i className="legend-swatch pointer" /> pointer</span></Panel>
              </ReactFlow>
            )}
          </div>
        </main>

        {inspectorOpen && <Inspector item={selected} onClose={() => { setInspectorOpen(false); setSelectedId(null); }} />}
      </div>
      {!sidebarOpen && <button className="mobile-filter-fab" type="button" onClick={() => setSidebarOpen(true)} title="Open filters" aria-label="Open filters"><Filter size={17} /></button>}
    </div>
  );
}
