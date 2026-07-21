import { ChevronDown, ChevronRight, Cpu, GitBranch } from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { MouseEvent } from "react";

import type { StructureNodeData } from "./types";

type StructureNodeProps = NodeProps<Node<StructureNodeData>>;

function value(value: string): string {
  return value === "None" || value === "" ? "-" : value;
}

export function StructureNode({ data, selected }: StructureNodeProps) {
  const { structure, expanded, graphId } = data;
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    data.onToggle(graphId);
  };

  return (
    <div className={`heap-node structure-node ${selected ? "is-selected" : ""} ${expanded ? "is-expanded" : ""}`}>
      <Handle className="node-handle node-handle-in" id="in" type="target" position={Position.Left} />
      <Handle className="node-handle node-handle-out" id="out" type="source" position={Position.Right} />
      <button className="node-header structure-header" type="button" onClick={() => data.onSelect(graphId)} title="Select management structure" aria-label={`Select ${structure.label}`}>
        <span className="node-kind"><Cpu size={13} strokeWidth={1.8} /> management</span>
        <span className="structure-label">{structure.label}</span>
        <span className="node-expand" aria-hidden="true">{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
      </button>
      <div className="structure-summary" onClick={() => data.onSelect(graphId)}>
        <span className="structure-kind">{structure.kind}</span>
        <span className="node-address">{value(structure.address)}</span>
        {structure.source && <span className="source-badge">{structure.source}</span>}
      </div>
      {expanded && (
        <div className="node-body structure-body" onClick={() => data.onSelect(graphId)}>
          <div className="section-label"><GitBranch size={12} /> fields</div>
          <div className="field-list">
            {structure.fields.slice(0, 16).map((field, index) => (
              <div className="field-row" key={`${field.name}-${index}`}>
                <span className="field-name">{field.name}</span>
                <span className={`field-value ${field.target ? "is-pointer" : ""}`}>{value(field.value)}</span>
              </div>
            ))}
            {structure.fields.length === 0 && <div className="payload-empty">no exposed fields</div>}
          </div>
        </div>
      )}
      <button className="node-expand-button" type="button" onClick={toggle} aria-label={expanded ? "Collapse structure" : "Expand structure"} aria-expanded={expanded} title={expanded ? "Collapse" : "Expand"}>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
    </div>
  );
}
