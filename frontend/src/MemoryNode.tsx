import { AlertTriangle, Binary, ChevronDown, ChevronRight, Database, Trash2 } from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { MouseEvent } from "react";

import { formatHex } from "./data";
import { isTypedMemoryView, memoryViewOption, reinterpretMemoryRows } from "./structViews";
import type { MemoryNodeData } from "./types";

type MemoryNodeProps = NodeProps<Node<MemoryNodeData>>;

function display(value: string | undefined, fallback = "-"): string {
  return value === undefined || value === "" || value === "None" ? fallback : value;
}

export function MemoryNode({ data, selected }: MemoryNodeProps) {
  const { memoryView, expanded, graphId } = data;
  const interpretation = isTypedMemoryView(memoryView.type)
    ? reinterpretMemoryRows(memoryView.data, memoryView.type, memoryView.pointerSize, memoryView.dataTruncated)
    : null;
  const option = memoryViewOption(memoryView.type);
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    data.onToggle(graphId);
  };
  const remove = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    data.onRemove(memoryView.id);
  };
  const select = () => data.onSelect(graphId);

  return (
    <div className={`heap-node memory-node ${selected ? "is-selected" : ""} ${expanded ? "is-expanded" : ""} ${memoryView.error ? "has-error" : ""}`}>
      <Handle className="node-handle node-handle-in" id="in" type="target" position={Position.Left} />
      <Handle className="node-handle node-handle-out" id="out" type="source" position={Position.Right} />
      <div className="memory-header node-header" role="button" tabIndex={0} onClick={select} onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") select();
      }} title="Select memory view">
        <span className="node-kind"><Binary size={13} strokeWidth={1.8} /> memory</span>
        <span className="memory-type">{memoryView.type}</span>
        <span className="node-address">{display(memoryView.address)}</span>
        <button className="memory-remove" type="button" onClick={remove} title="Remove memory view" aria-label={`Remove ${memoryView.type} memory view`}><Trash2 size={12} /></button>
      </div>

      <div className="memory-summary" onClick={select} role="button" tabIndex={0} onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") select();
      }}>
        <span><b>read</b> {formatHex(memoryView.availableSize)} / {formatHex(memoryView.requestedSize)} B</span>
        <span className="memory-pointer-width">{memoryView.pointerSize * 8}-bit</span>
        <span className={`memory-state ${memoryView.error || interpretation?.truncated ? "is-warning" : "is-ready"}`}>
          {memoryView.error ? "error" : interpretation?.truncated ? "partial" : "ready"}
        </span>
        <span className="node-expand" aria-hidden="true">{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
      </div>

      {expanded && (
        <div className="node-body memory-body" onClick={select}>
          <div className="section-label"><Database size={12} /> {option.label}</div>
          {memoryView.error && <div className="memory-error"><AlertTriangle size={12} /> <span>{memoryView.error}</span></div>}
          {interpretation?.truncated && <div className="memory-warning">captured bytes do not cover the complete layout</div>}
          {interpretation ? (
            <div className="field-list">
              {interpretation.fields.slice(0, 10).map((field) => (
                <div className="field-row" key={`${field.offset}-${field.name}`}>
                  <span className="field-name">{field.name}</span>
                  <span className={`field-value ${field.target ? "is-pointer" : ""}`}>{field.available ? field.value : "-"}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="memory-raw-summary">raw bytes only; use the dump panel to inspect this range</div>
          )}
        </div>
      )}
      <button className="node-expand-button" type="button" onClick={toggle} aria-label={expanded ? "Collapse memory view" : "Expand memory view"} aria-expanded={expanded} title={expanded ? "Collapse" : "Expand"}>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
    </div>
  );
}
