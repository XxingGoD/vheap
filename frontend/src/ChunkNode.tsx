import { ChevronDown, ChevronRight, Database, Link2, PackageOpen } from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { MouseEvent } from "react";

import { chunkBaseAddress, dataRows, fieldRows, formatHex, hexNumber } from "./data";
import type { ChunkNodeData } from "./types";

type ChunkNodeProps = NodeProps<Node<ChunkNodeData>>;

function flagClass(value: string): string {
  const numeric = hexNumber(value);
  return (Number.isFinite(numeric) ? numeric !== 0 : value.toLowerCase() === "true") ? "flag-on" : "flag-off";
}

function displayValue(value: string | undefined, fallback = "-"): string {
  return value === undefined || value === "None" || value === "" ? fallback : value;
}

export function ChunkNode({ data, selected }: ChunkNodeProps) {
  const { chunk, expanded, bin, graphId } = data;
  const fields = fieldRows(chunk);
  const payload = dataRows(chunk);
  const base = chunkBaseAddress(chunk, bin);
  const size = hexNumber(chunk.chunkSize);
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    data.onToggle(graphId);
  };
  const select = () => data.onSelect(graphId);

  return (
    <div className={`heap-node chunk-node ${selected ? "is-selected" : ""} ${expanded ? "is-expanded" : ""}`}>
      <Handle className="node-handle node-handle-in" id="in" type="target" position={Position.Left} />
      <Handle className="node-handle node-handle-out" id="out" type="source" position={Position.Right} />
      <button className="node-header" type="button" onClick={select} title="Select chunk" aria-label={`Select ${bin} chunk ${chunk.index}`}>
        <span className="node-kind"><PackageOpen size={13} strokeWidth={1.8} /> {bin}</span>
        <span className="node-index">[{chunk.index}]</span>
        <span className="node-address">{displayValue(chunk.address)}</span>
        <span className="node-expand" aria-hidden="true">
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </span>
      </button>

      <div className="chunk-summary" onClick={select} role="button" tabIndex={0} onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") select();
      }}>
        <span><b>size</b> {displayValue(chunk.chunkSize)}</span>
        <span><b>base</b> {formatHex(base)}</span>
        <span className={`flag ${flagClass(chunk.a)}`}>A:{chunk.a}</span>
        <span className={`flag ${flagClass(chunk.m)}`}>M:{chunk.m}</span>
        <span className={`flag ${flagClass(chunk.p)}`}>P:{chunk.p}</span>
        {Number.isFinite(size) && <span className="chunk-capacity">{size} B</span>}
      </div>

      {expanded && (
        <div className="node-body" onClick={select}>
          <div className="section-label"><Link2 size={12} /> chunk fields</div>
          <div className="field-list">
            {fields.slice(0, 16).map((field, index) => (
              <div className="field-row" key={`${field.name}-${index}`}>
                <span className="field-name">{field.name}</span>
                <span className={`field-value ${field.target ? "is-pointer" : ""}`}>{displayValue(field.value)}</span>
              </div>
            ))}
          </div>
          <div className="payload-heading">
            <span><Database size={12} /> payload</span>
            <span>{displayValue(chunk.dataAddress)} / {displayValue(chunk.dataSize)} B</span>
          </div>
          {chunk.dataDisabled ? (
            <div className="payload-empty">payload reads disabled</div>
          ) : payload.length === 0 ? (
            <div className="payload-empty">payload unavailable</div>
          ) : (
            <div className="payload-table">
              {payload.slice(0, 6).map((row, index) => (
                <div className="payload-row" key={`${row.offset}-${index}`}>
                  <span>{row.offset}</span>
                  <span>{row.value}</span>
                  <span>{row.ascii || row.bytes || ""}</span>
                </div>
              ))}
            </div>
          )}
          {chunk.dataTruncated && <div className="payload-truncated">payload truncated</div>}
        </div>
      )}
      <button className="node-expand-button" type="button" onClick={toggle} aria-label={expanded ? "Collapse chunk" : "Expand chunk"} aria-expanded={expanded} title={expanded ? "Collapse" : "Expand"}>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
    </div>
  );
}
