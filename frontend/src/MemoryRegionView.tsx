import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Binary,
  ChevronDown,
  ChevronUp,
  Copy,
  CornerDownLeft,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { canonicalAddress, memoryRegionRows, parseAddress } from "./data";
import { memoryViewOption } from "./structViews";
import type { MemoryRegionCell, MemoryViewRecord } from "./types";

const MAX_ADDRESS = 0xffffffffffffffffn;
const DEFAULT_PAGE_SIZE = 0x100;

interface MemoryRegionViewProps {
  view: MemoryViewRecord;
  views?: MemoryViewRecord[];
  busy?: boolean;
  onSelectView?: (id: string) => void;
  onNavigate?: (address: string) => void;
  onRefresh?: () => void;
  onClose?: () => void;
}

interface SelectedByte {
  address: string;
  value: number;
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
  return canonicalAddress(start + BigInt(size - 1));
}

function pageSize(view: MemoryViewRecord, rowCount: number): number {
  const requested = Number.isFinite(view.requestedSize) ? Math.trunc(view.requestedSize) : 0;
  const fallback = rowCount > 0 ? rowCount * 16 : DEFAULT_PAGE_SIZE;
  return Math.max(16, Math.min(0x10000, requested > 0 ? requested : fallback));
}

function status(view: MemoryViewRecord, busy: boolean): { label: string; className: string } {
  if (view.error) return { label: "error", className: "is-error" };
  if (busy && view.availableSize === 0 && view.data.length === 0) return { label: "reading", className: "is-reading" };
  if (view.dataTruncated || view.availableSize < view.requestedSize) return { label: "partial", className: "is-warning" };
  return { label: "ready", className: "is-ready" };
}

function addressForCell(view: MemoryViewRecord, rowOffset: number, cellIndex: number): string | null {
  const start = parseAddress(view.address);
  if (start === null) return null;
  return canonicalAddress(start + BigInt(rowOffset + cellIndex));
}

function offsetForAddress(view: MemoryViewRecord, address: string): number | null {
  const start = parseAddress(view.address);
  const selected = parseAddress(address);
  if (start === null || selected === null || selected < start) return null;
  const offset = selected - start;
  return offset <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(offset) : null;
}

export function MemoryRegionView({
  view,
  views = [],
  busy = false,
  onSelectView,
  onNavigate,
  onRefresh,
  onClose,
}: MemoryRegionViewProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [addressInput, setAddressInput] = useState(view.address);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [selectedByte, setSelectedByte] = useState<SelectedByte | null>(null);
  const rows = useMemo(() => memoryRegionRows(view), [view]);
  const state = status(view, busy);
  const canCopy = typeof navigator !== "undefined" && Boolean(navigator.clipboard);
  const selectedOffset = selectedByte ? offsetForAddress(view, selectedByte.address) : null;
  const currentAddress = parseAddress(view.address);
  const maxAddress = view.pointerSize === 4 ? 0xffffffffn : MAX_ADDRESS;
  const step = pageSize(view, rows.length);
  const previousAddress = currentAddress !== null && currentAddress >= BigInt(step)
    ? currentAddress - BigInt(step)
    : null;
  const nextAddress = currentAddress !== null && currentAddress <= maxAddress - BigInt(step)
    ? currentAddress + BigInt(step)
    : null;

  useEffect(() => {
    setAddressInput(view.address);
    setAddressError(null);
    setSelectedByte(null);
  }, [view.address, view.id]);

  const submitAddress = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = parseAddress(addressInput);
    if (parsed === null) {
      setAddressError("enter a hexadecimal or decimal address");
      return;
    }
    const address = canonicalAddress(parsed);
    setAddressError(null);
    onNavigate?.(address);
  };

  const movePage = (address: bigint | null) => {
    if (address === null) return;
    const next = canonicalAddress(address);
    setAddressInput(next);
    setAddressError(null);
    onNavigate?.(next);
  };

  const copySelected = () => {
    if (!selectedByte || !canCopy) return;
    const value = `0x${selectedByte.value.toString(16).padStart(2, "0")}`;
    void navigator.clipboard.writeText(`${selectedByte.address}: ${value}`).catch(() => undefined);
  };

  return (
    <section className={`memory-region-dock ${collapsed ? "is-collapsed" : ""}`} aria-label="Memory dump view">
      <div className="memory-region-topline">
        <div className="memory-region-heading">
          <Binary size={15} />
          <span className="memory-region-title">memory dump</span>
          {view.name && <span className="memory-region-name">{view.name}</span>}
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
              {views.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name?.trim() || memoryViewOption(candidate.type).label} / {candidate.address}</option>)}
            </select>
          )}
          <button className="icon-button" type="button" onClick={onRefresh} disabled={!onRefresh || busy} title="Refresh memory dump" aria-label="Refresh memory dump">
            <RefreshCw size={14} className={busy ? "is-spinning" : ""} />
          </button>
          <button className="icon-button" type="button" onClick={() => setCollapsed((value) => !value)} title={collapsed ? "Expand memory dump" : "Collapse memory dump"} aria-label={collapsed ? "Expand memory dump" : "Collapse memory dump"}>
            {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
          {onClose && <button className="icon-button" type="button" onClick={onClose} title="Close memory dump" aria-label="Close memory dump"><X size={15} /></button>}
        </div>
      </div>

      {!collapsed && (
        <div className="memory-region-content">
          <div className="memory-dump-commandbar">
            <form className="memory-dump-address-form" onSubmit={submitAddress}>
              <label htmlFor="memory-dump-address">address</label>
              <input id="memory-dump-address" value={addressInput} onChange={(event) => setAddressInput(event.target.value)} spellCheck={false} autoComplete="off" aria-label="Dump start address" />
              <button className="icon-button memory-dump-go" type="submit" disabled={!onNavigate || busy} title="Go to address" aria-label="Go to address"><CornerDownLeft size={14} /></button>
            </form>
            <div className="memory-dump-page-actions" aria-label="Memory dump page navigation">
              <button className="icon-button" type="button" onClick={() => movePage(previousAddress)} disabled={!previousAddress || !onNavigate || busy} title={`Previous ${step} bytes`} aria-label={`Previous ${step} bytes`}><ArrowLeft size={14} /></button>
              <span><code>0x{step.toString(16).toUpperCase()}</code> B page</span>
              <button className="icon-button" type="button" onClick={() => movePage(nextAddress)} disabled={!nextAddress || !onNavigate || busy} title={`Next ${step} bytes`} aria-label={`Next ${step} bytes`}><ArrowRight size={14} /></button>
            </div>
          </div>
          {addressError && <div className="memory-dump-address-error"><AlertTriangle size={12} /><span>{addressError}</span></div>}

          <div className="memory-region-meta">
            <span><b>range</b> {view.address} - {rangeEnd(view)}</span>
            <span><b>read</b> {view.availableSize} / {view.requestedSize} B</span>
            <span><b>type</b> {memoryViewOption(view.type).label}</span>
            <span><b>source</b> {view.source ?? "-"}</span>
          </div>
          {view.error && <div className="memory-region-error"><AlertTriangle size={13} /><span>{view.error}</span></div>}
          {rows.length === 0 ? (
            <div className="memory-region-empty">no addressable bytes in this range</div>
          ) : (
            <div className="memory-region-scroll" role="region" aria-label="Memory bytes">
              <div className="memory-region-grid memory-region-grid-head" role="row">
                <span className="memory-region-address-head">address</span>
                {Array.from({ length: 4 }, (_, group) => <span className="memory-region-byte-group-head" key={group}>{Array.from({ length: 4 }, (_, index) => <span key={index}>{(group * 4 + index).toString(16).padStart(2, "0")}</span>)}</span>)}
                <span className="memory-region-ascii-head">ascii</span>
              </div>
              {rows.map((row) => (
                <div className={`memory-region-grid memory-region-grid-line ${selectedOffset !== null && selectedOffset >= row.offset && selectedOffset < row.offset + 16 ? "is-selected-row" : ""}`} role="row" key={row.offset}>
                  <code className="memory-region-address">{row.address}</code>
                  {Array.from({ length: 4 }, (_, group) => (
                    <span className="memory-region-byte-group" key={group}>
                      {row.cells.slice(group * 4, group * 4 + 4).map((cell, index) => {
                        const cellIndex = group * 4 + index;
                        const cellAddress = addressForCell(view, row.offset, cellIndex);
                        const selected = selectedByte?.address === cellAddress;
                        return (
                          <button
                            className={`memory-region-byte ${cell.value === null ? "is-missing" : ""} ${!cell.inRange ? "is-outside" : ""} ${selected ? "is-selected" : ""}`}
                            key={`${row.offset}-${cellIndex}`}
                            type="button"
                            disabled={cell.value === null || !cell.inRange}
                            aria-pressed={selected}
                            onClick={() => cell.value === null || cellAddress === null ? undefined : setSelectedByte({ address: cellAddress, value: cell.value })}
                            title={`${cellAddress ?? row.address}+0x${cellIndex.toString(16)}${cell.value === null ? ": unavailable" : `: 0x${byteText(cell)}`}`}
                          >
                            {byteText(cell)}
                          </button>
                        );
                      })}
                    </span>
                  ))}
                  <code className="memory-region-ascii" aria-label={`ASCII at ${row.address}`}>
                    {row.cells.map((cell, index) => {
                      const cellOffset = row.offset + index;
                      return <span className={`memory-region-ascii-char ${selectedOffset === cellOffset ? "is-selected" : ""}`} key={`${row.offset}-ascii-${index}`}>{asciiText(cell)}</span>;
                    })}
                  </code>
                </div>
              ))}
            </div>
          )}
          <div className="memory-region-selection" aria-live="polite">
            {selectedByte ? (
              <><span>selected</span><code>{selectedByte.address}</code><code>0x{selectedByte.value.toString(16).padStart(2, "0")}</code><button className="mini-icon" type="button" onClick={copySelected} disabled={!canCopy} title="Copy address and byte" aria-label="Copy address and byte"><Copy size={12} /></button></>
            ) : <span>select a byte to inspect its address and value</span>}
          </div>
          {view.dataTruncated && <div className="memory-region-footnote">read ended before the requested range</div>}
        </div>
      )}
    </section>
  );
}
