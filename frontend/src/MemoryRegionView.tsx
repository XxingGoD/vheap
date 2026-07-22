import { AlertTriangle, Binary, ChevronDown, ChevronUp, RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";

import { memoryRegionRows, parseAddress } from "./data";
import type { MemoryRegionCell, MemoryViewRecord } from "./types";

interface MemoryRegionViewProps {
  view: MemoryViewRecord;
  views?: MemoryViewRecord[];
  busy?: boolean;
  onSelectView?: (id: string) => void;
  onRefresh?: () => void;
  onClose?: () => void;
}

function byteText(cell: MemoryRegionCell): string {
  return cell.value === null ? "--" : cell.value.toString(16).padStart(2, "0");
}

function asciiText(cell: MemoryRegionCell): string {
  if (cell.value === null) return " ";
  return cell.value >= 0x20 && cell.value < 0x7f ? String.fromCharCode(cell.value) : ".";
}

function rangeEnd(view: MemoryViewRecord): string {
  const start = parseAddress(view.address);
  const size = Number.isFinite(view.requestedSize) ? Math.max(0, Math.trunc(view.requestedSize)) : 0;
  if (start === null || size < 1) return "-";
  return `0x${(start + BigInt(size - 1)).toString(16)}`;
}

function status(view: MemoryViewRecord): { label: string; className: string } {
  if (view.error) return { label: "error", className: "is-error" };
  if (view.dataTruncated || view.availableSize < view.requestedSize) return { label: "partial", className: "is-warning" };
  return { label: "ready", className: "is-ready" };
}

export function MemoryRegionView({
  view,
  views = [],
  busy = false,
  onSelectView,
  onRefresh,
  onClose,
}: MemoryRegionViewProps) {
  const [collapsed, setCollapsed] = useState(false);
  const rows = useMemo(() => memoryRegionRows(view), [view]);
  const state = status(view);

  return (
    <section className={`memory-region-dock ${collapsed ? "is-collapsed" : ""}`} aria-label="Memory region view">
      <div className="memory-region-topline">
        <div className="memory-region-heading">
          <Binary size={15} />
          <span className="memory-region-title">memory region</span>
          <code>{view.address}</code>
          <span className={`memory-region-state ${state.className}`}>{state.label}</span>
        </div>
        <div className="memory-region-actions">
          {views.length > 1 && onSelectView && (
            <select
              className="memory-region-picker"
              value={view.id}
              onChange={(event) => onSelectView(event.target.value)}
              aria-label="Select memory view"
            >
              {views.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.address} / {candidate.type}</option>)}
            </select>
          )}
          <button className="icon-button" type="button" onClick={onRefresh} disabled={!onRefresh || busy} title="Refresh memory region" aria-label="Refresh memory region">
            <RefreshCw size={14} className={busy ? "is-spinning" : ""} />
          </button>
          <button className="icon-button" type="button" onClick={() => setCollapsed((value) => !value)} title={collapsed ? "Expand memory region" : "Collapse memory region"} aria-label={collapsed ? "Expand memory region" : "Collapse memory region"}>
            {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
          {onClose && <button className="icon-button" type="button" onClick={onClose} title="Close memory region" aria-label="Close memory region"><X size={15} /></button>}
        </div>
      </div>

      {!collapsed && (
        <div className="memory-region-content">
          <div className="memory-region-meta">
            <span><b>range</b> {view.address} - {rangeEnd(view)}</span>
            <span><b>read</b> {view.availableSize} / {view.requestedSize} B</span>
            <span><b>type</b> {view.type}</span>
            <span><b>source</b> {view.source ?? "-"}</span>
          </div>
          {view.error && <div className="memory-region-error"><AlertTriangle size={13} /><span>{view.error}</span></div>}
          {rows.length === 0 ? (
            <div className="memory-region-empty">no addressable bytes in this range</div>
          ) : (
            <div className="memory-region-scroll" role="region" aria-label="Memory bytes">
              <div className="memory-region-grid memory-region-grid-head" role="row">
                <span className="memory-region-address-head">address</span>
                {Array.from({ length: 16 }, (_, index) => <span key={index}>{index.toString(16).padStart(2, "0")}</span>)}
                <span className="memory-region-ascii-head">ascii</span>
              </div>
              {rows.map((row) => (
                <div className="memory-region-grid memory-region-grid-line" role="row" key={row.offset}>
                  <code className="memory-region-address">{row.address}</code>
                  {row.cells.map((cell, index) => (
                    <span
                      className={`memory-region-byte ${cell.value === null ? "is-missing" : ""} ${!cell.inRange ? "is-outside" : ""}`}
                      key={`${row.offset}-${index}`}
                      title={`${row.address}+0x${index.toString(16)}${cell.value === null ? ": unavailable" : `: 0x${byteText(cell)}`}`}
                    >
                      {byteText(cell)}
                    </span>
                  ))}
                  <code className="memory-region-ascii" aria-label={`ASCII at ${row.address}`}>{row.cells.map(asciiText).join("")}</code>
                </div>
              ))}
            </div>
          )}
          {view.dataTruncated && <div className="memory-region-footnote">read ended before the requested range</div>}
        </div>
      )}
    </section>
  );
}

