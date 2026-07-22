import { AlertTriangle, Binary, Clipboard, Code2, Database, ExternalLink, FileJson, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { chunkBaseAddress, dataRows, fieldRows, formatHex } from "./data";
import { CHUNK_VIEW_OPTIONS, chunkViewOption, isTypedMemoryView, memoryViewOption, reinterpretChunk, reinterpretMemoryRows } from "./structViews";
import type { ChunkViewField, ChunkViewType, SelectedItem } from "./types";

interface InspectorProps {
  item: SelectedItem | null;
  onClose: () => void;
  onRemoveMemoryView: (id: string) => void;
  onRenameMemoryView: (id: string, name: string) => void;
}

function value(value: string | undefined): string {
  return value === undefined || value === "None" || value === "" ? "-" : value;
}

function copyValue(raw: string): void {
  if (typeof navigator !== "undefined" && navigator.clipboard) void navigator.clipboard.writeText(raw);
}

export function Inspector({ item, onClose, onRemoveMemoryView, onRenameMemoryView }: InspectorProps) {
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
      ) : item.kind === "memory" ? (
        <MemoryInspector item={item} onRemove={onRemoveMemoryView} onRename={onRenameMemoryView} />
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
      {field.target && <div className="typed-field-target">pointer target <code>{field.target}</code></div>}
      {field.note && <div className="typed-field-note">{field.note}</div>}
    </div>
  );
}

function MemoryInspector({
  item,
  onRemove,
  onRename,
}: {
  item: Extract<SelectedItem, { kind: "memory" }>;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const { memoryView } = item;
  const interpreted = isTypedMemoryView(memoryView.type)
    ? reinterpretMemoryRows(memoryView.data, memoryView.type, memoryView.pointerSize, memoryView.dataTruncated)
    : null;
  const visibleRows = memoryView.data.slice(0, 96);
  const [nameInput, setNameInput] = useState(memoryView.name ?? "");
  const skipNameBlur = useRef(false);
  useEffect(() => setNameInput(memoryView.name ?? ""), [memoryView.id, memoryView.name]);
  const commitName = () => {
    if (skipNameBlur.current) {
      skipNameBlur.current = false;
      return;
    }
    onRename(memoryView.id, nameInput.trim());
  };
  const option = memoryViewOption(memoryView.type);
  const displayName = memoryView.name?.trim() || option.label;
  return (
    <div className="inspector-content">
      <div className="inspector-heading"><span className="node-kind">memory</span><h2>{displayName}</h2></div>
      <div className="inspector-subtitle">{value(memoryView.address)}</div>
      <div className="memory-inspector-actions">
        <label className="memory-source-label" htmlFor="memory-inspector-name">name</label>
        <input
          id="memory-inspector-name"
          className="memory-name-input"
          value={nameInput}
          onChange={(event) => setNameInput(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitName();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              skipNameBlur.current = true;
              setNameInput(memoryView.name ?? "");
              event.currentTarget.blur();
            }
          }}
          placeholder={option.label}
          spellCheck={false}
          autoComplete="off"
          aria-label="Memory view name"
        />
        <button className="remove-memory-button" type="button" onClick={() => onRemove(memoryView.id)}><Trash2 size={13} /> remove view</button>
      </div>
      <div className="copy-grid">
        <CopyValue label="address" raw={memoryView.address} />
        <CopyValue label="type" raw={memoryView.type} />
        <CopyValue label="read" raw={`${memoryView.availableSize} / ${memoryView.requestedSize} B`} />
        <CopyValue label="pointer" raw={`${memoryView.pointerSize * 8}-bit`} />
      </div>
      {memoryView.error && <div className="memory-inspector-error"><AlertTriangle size={14} /><span>{memoryView.error}</span></div>}
      {interpreted ? (
        <InspectorSection title={interpreted.label} icon={<Code2 size={13} />}>
          <div className="view-type-meta">
            <span>{interpreted.pointerSize * 8}-bit pointers</span>
            <span>{formatHex(interpreted.availableSize)} / {formatHex(interpreted.expectedSize)} bytes</span>
          </div>
          {interpreted.truncated && <div className="view-type-warning">captured bytes are shorter than the selected structure layout</div>}
          <div className="typed-field-list">
            {interpreted.fields.map((field) => <TypedField key={`${field.offset}-${field.name}`} field={field} />)}
          </div>
        </InspectorSection>
      ) : (
        <InspectorSection title="raw bytes" icon={<Binary size={13} />}>
          <div className="payload-empty">no structure interpretation applied</div>
        </InspectorSection>
      )}
      <InspectorSection title="raw memory" icon={<Database size={13} />}>
        <div className="payload-info"><span>{value(memoryView.address)}</span><span>{memoryView.availableSize} bytes</span></div>
        {memoryView.dataDisabled ? <div className="payload-empty">memory reads disabled</div> : visibleRows.length === 0 ? <div className="payload-empty">no bytes returned</div> : (
          <div className="inspector-payload-table">
            <div className="payload-table-head"><span>offset</span><span>value</span><span>ascii</span></div>
            {visibleRows.map((row, index) => <div className="payload-table-line" key={`${row.offset}-${index}`}><span>{row.offset}</span><code>{row.value}</code><span>{row.ascii || row.bytes || ""}</span></div>)}
          </div>
        )}
        {memoryView.dataTruncated && <div className="payload-truncated">memory read truncated before the requested length</div>}
        {memoryView.data.length > visibleRows.length && <div className="payload-truncated">{memoryView.data.length - visibleRows.length} rows omitted</div>}
      </InspectorSection>
      {memoryView.source && <div className="source-line">source <code>{memoryView.source}</code></div>}
      <details className="raw-details"><summary><FileJson size={13} /> raw memory view JSON</summary><pre>{JSON.stringify(memoryView, null, 2)}</pre></details>
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
