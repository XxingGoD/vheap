import { ArrowRight, ListTree } from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import type { BinHeadNodeData } from "./types";

type BinHeadNodeProps = NodeProps<Node<BinHeadNodeData>>;

export function BinHeadNode({ data, selected }: BinHeadNodeProps) {
  return (
    <div className={`heap-node bin-head-node ${selected ? "is-selected" : ""}`} onClick={() => data.onSelect(data.graphId)} role="button" tabIndex={0} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") data.onSelect(data.graphId);
    }}>
      <Handle className="node-handle node-handle-out" id="out" type="source" position={Position.Right} />
      <div className="head-title"><ListTree size={14} /> <span>{data.head}</span></div>
      <div className="head-meta"><span>{data.address}</span><span>{data.count} visible</span><ArrowRight size={13} /></div>
    </div>
  );
}
