import { Clipboard, Code2, Database, ExternalLink, FileJson, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { chunkBaseAddress, dataRows, fieldRows, formatHex } from "./data";
import { CHUNK_VIEW_OPTIONS, chunkViewOption, reinterpretChunk } from "./structViews";
import type { ChunkViewField, ChunkViewType, SelectedItem } from "./types";

interface InspectorProps {
  item: SelectedItem | null;
  onClose: () => void;
}

function value(value: string | undefined): string {
  return value === undefined || value === "None" || value === "" ? "-" : value;
}

function copyValue(raw: string): void {
  if (typeof navigator !== "undefined" && navigator.clipboard) void navigator.clipboard.writeText(raw);
}

export function Inspector({ item, onClose }: InspectorProps) {
  const [chunkViewTypes, setChunkViewTypes] = useState<Record<string, ChunkViewType>>({});
  return (
    <aside className={`inspector ${item ? "has-selection" : ""}`} aria-label="Inspector">
      <div className="inspector-topline">
        <div><span className="eyebrow">INSPECTOR</span><span className="inspector-state">{item ? "selected" : "idle"}</span></div>
        {item && <button className="icon-button" type="button" onClick={onClose} title="Close inspector" aria-label="Close inspector"><X size={16} /></button>}
      </div>
      {!item ? (
        <div className="inspector-empty">
          <ExternalLink size={20} />
          <p>No node selected.</p>
        </div>
      ) : item.kind === "chunk" ? (
        <ChunkInspector
          item={item}
          viewType={chunkViewTypes[item.id] ?? "malloc_chunk"}
          onViewTypeChange={(type) => setChunkViewTypes((previous) => ({ ...previous, [item.id]: type }))}
        />
      ) : item.kind === "structure" ? (
        <StructureInspector item={item} />
      ) : (
        <HeadInspector item={item} />
      )}
    </aside>
  );
}

function CopyValue({ label, raw, disabled = false }: { label: string; raw: string; disabled?: boolean }) {
  return (
    <div className="copy-value">
      <span className="field-name">{label}</span>
      <code>{value(raw)}</code>
      <button className="mini-icon" type="button" disabled={disabled} onClick={() => copyValue(raw)} title="Copy value" aria-label={`Copy ${label}`}><Clipboard size={12} /></button>
    </div>
  );
}

function ChunkInspector({
  item,
  viewType,
  onViewTypeChange,
}: {
  item: Extract<SelectedItem, { kind: "chunk" }>;
  viewType: ChunkViewType;
  onViewTypeChange: (type: ChunkViewType) => void;
}) {
  const { chunk, bin } = item;
  const rows = dataRows(chunk);
  const visibleRows = rows.slice(0, 128);
  const interpreted = viewType === "malloc_chunk" ? null : reinterpretChunk(chunk, viewType);
  const selectedOption = chunkViewOption(viewType);
  return (
    <div className="inspector-content">
      <div className="inspector-heading"><span className="node-kind">{bin}</span><h2>chunk [{chunk.index}]</h2></div>
      <div className="inspector-subtitle">{value(chunk.address)}</div>
      <div className="view-type-picker">
        <label htmlFor="chunk-view-type">reinterpret payload</label>
        <select id="chunk-view-type" value={viewType} onChange={(event) => onViewTypeChange(event.target.value as ChunkViewType)}>
          {CHUNK_VIEW_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <div className="view-type-description">{selectedOption.description}</div>
      <div className="copy-grid">
        <CopyValue label="address" raw={chunk.address} />
        <CopyValue label="base" raw={formatHex(chunkBaseAddress(chunk, bin))} />
        <CopyValue label="size" raw={chunk.chunkSize} />
        <CopyValue label="header" raw={chunk.headerSize ?? "16"} />
      </div>
      {interpreted ? (
        <InspectorSection title={interpreted.label} icon={<Code2 size={13} />}>
          <div className="view-type-meta">
            <span>{interpreted.pointerSize * 8}-bit pointers</span>
            <span>{formatHex(interpreted.availableSize)} / {formatHex(interpreted.expectedSize)} bytes</span>
          </div>
          {interpreted.truncated && (
            <div className="view-type-warning">
              {chunk.dataDisabled
                ? "payload reads are disabled; run vhstate --data-bytes 256"
                : `payload is incomplete; run vhstate --data-bytes ${Math.max(256, interpreted.expectedSize)}`}
            </div>
          )}
          <div className="typed-field-list">
            {interpreted.fields.map((field) => <TypedField key={`${field.offset}-${field.name}`} field={field} />)}
          </div>
        </InspectorSection>
      ) : (
        <InspectorSection title="malloc_chunk">
          <div className="inspector-fields">
            {fieldRows(chunk).map((field, index) => <CopyValue key={`${field.name}-${index}`} label={field.name} raw={field.value} />)}
          </div>
        </InspectorSection>
      )}
      <InspectorSection title="payload" icon={<Database size={13} />}>
        <div className="payload-info"><span>{value(chunk.dataAddress)}</span><span>{value(chunk.dataSize)} bytes</span></div>
        {chunk.dataDisabled ? <div className="payload-empty">payload reads disabled</div> : rows.length === 0 ? <div className="payload-empty">payload unavailable</div> : (
          <div className="inspector-payload-table">
            <div className="payload-table-head"><span>offset</span><span>value</span><span>ascii</span></div>
            {visibleRows.map((row, index) => <div className="payload-table-line" key={`${row.offset}-${index}`}><span>{row.offset}</span><code>{row.value}</code><span>{row.ascii || row.bytes || ""}</span></div>)}
          </div>
        )}
        {chunk.dataTruncated && <div className="payload-truncated">payload truncated</div>}
        {rows.length > visibleRows.length && <div className="payload-truncated">{rows.length - visibleRows.length} payload rows omitted</div>}
      </InspectorSection>
      <details className="raw-details">
        <summary><FileJson size={13} /> raw chunk JSON</summary>
        <pre>{JSON.stringify(chunk, null, 2)}</pre>
      </details>
    </div>
  );
}

function TypedField({ field }: { field: ChunkViewField }) {
  return (
    <div className={`typed-field ${field.available ? "" : "is-unavailable"}`}>
      <div className="typed-field-topline">
        <div className="typed-field-name"><span>{field.name}</span><small>{field.offset} / {field.size} B / {field.type}</small></div>
        <div className="typed-field-value">
          <code>{field.available ? field.value : "-"}</code>
          <button className="mini-icon" type="button" disabled={!field.available} onClick={() => copyValue(field.value)} title="Copy value" aria-label={`Copy ${field.name}`}><Clipboard size={12} /></button>
        </div>
      </div>
      {field.note && <div className="typed-field-note">{field.note}</div>}
    </div>
  );
}

function StructureInspector({ item }: { item: Extract<SelectedItem, { kind: "structure" }> }) {
  const { structure } = item;
  return (
    <div className="inspector-content">
      <div className="inspector-heading"><span className="node-kind">management</span><h2>{structure.label}</h2></div>
      <div className="inspector-subtitle">{structure.kind} / {value(structure.address)}</div>
      <InspectorSection title="structure fields">
        <div className="inspector-fields">
          {structure.fields.map((field, index) => <CopyValue key={`${field.name}-${index}`} label={field.name} raw={field.value} />)}
          {structure.fields.length === 0 && <div className="payload-empty">no exposed fields</div>}
        </div>
      </InspectorSection>
      {structure.source && <div className="source-line">source <code>{structure.source}</code></div>}
      <details className="raw-details"><summary><FileJson size={13} /> raw structure JSON</summary><pre>{JSON.stringify(structure, null, 2)}</pre></details>
    </div>
  );
}

function HeadInspector({ item }: { item: Extract<SelectedItem, { kind: "head" }> }) {
  return (
    <div className="inspector-content">
      <div className="inspector-heading"><span className="node-kind">bin head</span><h2>{item.head}</h2></div>
      <div className="copy-grid"><CopyValue label="address" raw={item.address} /><CopyValue label="visible" raw={String(item.count)} /></div>
      <InspectorSection title="entry point"><div className="head-inspector-note">This node is the allocator list entry for the visible bin.</div></InspectorSection>
    </div>
  );
}

function InspectorSection({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return <section className="inspector-section"><h3>{icon}{title}</h3>{children}</section>;
}
