/*************************************************************************
 * Vheap.js, Main class. 
 * handles data
 */

/* GLOBAL */
var hchunks   = null; // All current heap chunks
var binsheads = null; // All current heap bins heads
var structures = [];  // ptmalloc management structures

function defaultChunkFields(prevSize, chunkSize, a, m, p, fd, bk) {
	return [
		{"name": "prev_size", "value": prevSize, "port": "prevSize"},
		{"name": "size", "value": chunkSize, "port": "size"},
		{"name": "A", "value": a, "port": "flagsA"},
		{"name": "M", "value": m, "port": "flagsM"},
		{"name": "P", "value": p, "port": "flagsP"},
		{"name": "fd", "value": fd, "port": "fdPtr"},
		{"name": "bk", "value": bk, "port": "bkPtr"}
	];
}

function ChunkStruct(bin, index, address, prevSize, chunkSize, a, m, p, fd, bk, fields, data, dataAddress, dataSize, dataTruncated, dataDisabled, headerSize) {
	this.bin = bin;
	this.index = index;
	this.address = address;
	this.prevSize = prevSize;
	this.chunkSize = chunkSize;
	this.a = a;
	this.m = m;
	this.p = p;
	this.fd = fd;
	this.bk = bk;
	this.headerSize = Number(headerSize) || 16;
	this.fields = fields || defaultChunkFields(prevSize, chunkSize, a, m, p, fd, bk);
	this.data = data || [];
	this.dataAddress = dataAddress || "None";
	this.dataSize = dataSize || "0x0";
	this.dataTruncated = Boolean(dataTruncated);
	this.dataDisabled = Boolean(dataDisabled);

	this.extended = {"rows": [], "backgroundColor": ""};
}

function dotEscape(value) {
	return String(value === undefined || value === null ? "" : value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/[\r\n]+/g, " ");
}

function dotPort(value) {
	return String(value === undefined || value === null ? "field" : value).replace(/[^A-Za-z0-9_]/g, "_");
}

function structureNodeId(structure, index) {
	var raw = structure && structure.id ? structure.id : `structure_${index}`;
	return `structure_${String(raw).replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function chunkNodeId(chunk) {
	return `${dotPort(chunk.bin)}_${dotPort(chunk.index)}`;
}

/*
* InitHeap: Initalizer. 
* handles converting json to chunks struct, initializing the bins heads, and the chunks
*/
function InitHeap(jsonChunks) {
	binsheads = {};
	hchunks = [];

	var jdata = JSON.parse(jsonChunks);
	structures = jdata["structures"] || [];
	
	var heads = jdata["heads"];
	
	// Init bins heads
	for(var head in heads) {
		binsheads[head] = heads[head];
	}


	 var bins = jdata["bins"];
		 for(var bin in bins) {
			 for(var i = 0; i < bins[bin].length; i++) {
				 var jchunk = bins[bin][i];
				 var chunk = new ChunkStruct(
				 bin,
				 jchunk.index,
				 jchunk.address,
				 jchunk.prevSize,
				 jchunk.chunkSize,
				 jchunk.a,
			         jchunk.m,
					 jchunk.p,
					 jchunk.fd,
					 jchunk.bk,
					 jchunk.fields,
					 jchunk.data,
					 jchunk.dataAddress,
					 jchunk.dataSize,
					 jchunk.dataTruncated,
					 jchunk.dataDisabled,
					 jchunk.headerSize
				 );

			 hchunks.push(chunk);
		 }
	 }
	

	// figure out allocated chunks
	var allocated = 0;
	for(var c = 0; c < hchunks.length; c++) {
		var currentChunk = hchunks[c];

		if(currentChunk.bin == "allchunks") {
			// set chunks in allchunks array to allocated
			hchunks[c].bin = "allocated";
			allocated += 1;

			// check if chunk in one of freelists
			for(var ca = 0; ca < hchunks.length; ca++) {
				var checkChunk = hchunks[ca];
			
				if(checkChunk.bin != "allchunks" && c != ca) {

					// chunk found in freelist. remove it from all chunks and keep it in list
					if(    ((hInt(currentChunk.address) == hInt(checkChunk.address)) || 	    // If found
						(hInt(currentChunk.address) == (hInt(checkChunk.address)-checkChunk.headerSize) ))     // Additional check for tcache bins frees
														    // (the all chunks are addressed from begining while tcache after (prevSize+size+flags) )
						
					) {
						// remove from all chunks. keep in bin
						hchunks[c].bin = "toRemove";
						allocated -= 1;
					}
				}
			}
		}
	
	}

	// remove free chunks from allocated chunks
	for(var r = hchunks.length - 1; r >= 0; r--) { if(hchunks[r].bin == "toRemove") { hchunks.splice(r, 1);  }  }
	
	// set allocated count
	binsheads["allocated"] = `${allocated}`;
	delete binsheads["allchunkshead"];


}




/*
* makeHeadsDot: Generates the bins heads d3js-graphviz dot text. 
*/
function makeHeadsDot() {	
	var hdot = "\n// Heads \n"; 
	
	hdot +=`
		heads [
			shape = none;
			fontcolor=white;
			label=<<table border="0" color="#4c505c" bgcolor="#1b1e25" cellspacing="0">
              `;	

	for(var head in binsheads) {
		var headPort = dotPort(head);
		hdot += `
			<tr border="0">
				<td port="${headPort}" border="1"><font color="#e49f33">${dotEscape(head)}[]</font>: ${dotEscape(binsheads[head])} </td>
			</tr>` + "\n"; 
	}

	hdot += "</table>>];\n";
	return hdot;
}


/*
* makeBinDot: Generates a bin with its chunks d3js-graphviz dot text. 
*/
function makeBinDot(bin) {

	var binChunks = getBinChunks(bin);
	if(binChunks.length === 0) { return ""; }


	// bit colors for A,M,P flags
	var bcolors = ["#d02d2d", "#44cc54"];

	var cdot = "//" + bin + " chunks\n";
	for(var i = 0; i < binChunks.length; i++) {
		var chunk = binChunks[i];

		// handle chunk background color set
		var backgroundColor = "#1b1e25";
		if(chunk.extended.backgroundColor != "") {
			backgroundColor = chunk.extended.backgroundColor;
		}
		
		var nodeId = `${dotPort(bin)}_${dotPort(chunk.index)}`;
		cdot += `
				${nodeId} [
				    shape = none;
				    fontcolor=white;
				    
				    label=<<table color="#4c505c" bgcolor="${backgroundColor}" border="0" cellspacing="0">
				    
				    <tr border="0">
				    	<td colspan="4" bgcolor="#0b0d0e" border="1"><font color="#e49f33">${dotEscape(bin)}[${dotEscape(chunk.index)}]</font>: ${dotEscape(chunk.address)} </td>
				    </tr>
		`;

		var fields = chunk.fields || defaultChunkFields(chunk.prevSize, chunk.chunkSize, chunk.a, chunk.m, chunk.p, chunk.fd, chunk.bk);
		for(var f = 0; f < fields.length; f++) {
			var field = fields[f] || {};
			var fieldName = field.name || "field";
			var fieldColor = "white";
			if(fieldName === "A") { fieldColor = bcolors[Number(chunk.a)] || "white"; }
			if(fieldName === "M") { fieldColor = bcolors[Number(chunk.m)] || "white"; }
			if(fieldName === "P") { fieldColor = bcolors[Number(chunk.p)] || "white"; }
			var portAttribute = field.port ? ` port="${dotPort(field.port)}"` : "";
			cdot += `
				    <tr border="0">
				    	<td${portAttribute} colspan="4" border="1"><font color="${fieldColor}">${dotEscape(fieldName)}</font>: ${dotEscape(field.value)}</td>
				    </tr>`;
		}

		var dataRows = chunk.data || [];
		cdot += `
				    <tr border="0">
				    	<td colspan="4" bgcolor="#0b0d0e" border="1">data @ ${dotEscape(chunk.dataAddress)} (${dotEscape(chunk.dataSize)} bytes)</td>
				    </tr>`;
		if(dataRows.length === 0) {
			var dataStatus = chunk.dataDisabled ? "data disabled" : "data unavailable";
			cdot += `<tr border="0"><td port="data" colspan="4" border="1">${dataStatus}</td></tr>`;
		} else {
			for(var d = 0; d < dataRows.length; d++) {
				var dataRow = dataRows[d];
				var dataPort = d === 0 ? ` port="data"` : "";
				cdot += `
				    <tr border="0">
				    	<td${dataPort} border="1">${dotEscape(dataRow.offset)}</td>
				    	<td border="1">${dotEscape(dataRow.address)}</td>
				    	<td border="1">${dotEscape(dataRow.value)} [${dotEscape(dataRow.bytes || "")} ]</td>
				    	<td border="1">${dotEscape(dataRow.ascii)}</td>
				    </tr>`;
			}
		}
		if(chunk.dataTruncated) {
			cdot += `<tr border="0"><td colspan="4" border="1"><font color="#e49f33">payload truncated</font></td></tr>`;
		}

		// Handle extensions
		for(var c = 0; c < chunk.extended.rows.length; c++) {
			var ecolor = chunk.extended.rows[c]["color"];
			var etext  = chunk.extended.rows[c]["text"];

			cdot += `                           
			    <tr border="0">
			    	<td colspan="4" bgcolor="#0b0d0e" border="1"><font color="${ecolor}">${dotEscape(etext)}</font> </td>
			    </tr>` + "\n";
		}

		cdot += 
		`
			</table>>
          		];
		`;

	}

	return cdot;
}


/*
* makeChunksEdgesDot: Generates the edges between chunks and heads, etc .. d3js-graphviz dot text. 
*/
function makeChunksEdgesDot() {

	var edges = "\n// Edges \n";


	// heads to chunks
	for(var head in binsheads) {
		for(var k = 0; k < hchunks.length; k++) {
			var checkChunk = hchunks[k];

			// Only tcache bins point right back at the chunk data space where fd/bk are
			// other bins point at prevSize (real begining of chunk)

			var pointAt = "prevSize";
			if(checkChunk.bin.includes("tcache")) {
				pointAt = "fdPtr";
			}

			// Handle heads to chunks extensions next
			onCreateEdgeFromHeadToChunkNext(binsheads, hchunks, head, k);

			if (binsheads[head] == checkChunk.address) {
				edges += `heads:${dotPort(head)} -> ${chunkNodeId(checkChunk)}:${pointAt}` + "\n";
			}
		}
	}

	// Chunks to chunks
	
	var lastAllocated = {};

	for(var i = 0; i < hchunks.length; i++) {
		
		var currentChunk = hchunks[i];
	
		// Handle chunks to chunks extensions init
		onCreateEdgeFromChunkToChunkInit(hchunks, i);


		// Invisivle edge between allocated chunk (ranking by size. to make graph more organized)
		if(currentChunk.bin == "allocated" && !(currentChunk.chunkSize in lastAllocated)) {
			lastAllocated[currentChunk.chunkSize] = currentChunk;
		} else if(currentChunk.bin == "allocated" && currentChunk.chunkSize in lastAllocated) {
			var from = lastAllocated[currentChunk.chunkSize];
			edges += `${chunkNodeId(from)}:fdPtr -> ${chunkNodeId(currentChunk)}:fdPtr [style=invis]` + "\n";
			
			lastAllocated[currentChunk.chunkSize] = currentChunk;
		}


		// Check against other chunks	
		for(var j = 0; j < hchunks.length; j++) {	
			var checkChunk = hchunks[j];
			
			// Handle chunk to chunk extensions next
			onCreateEdgeFromChunkToChunkNext(hchunks, i, j);

			// Regular edge fd/bk
			// Only tcache bins point right back at the chunk data space where fd/bk are
			// other bins point at prevSize (real begining of chunk)
		
			pointAt = "prevSize";
			if(currentChunk.bin.includes("tcache")) {
				pointAt = "fdPtr";
			}

			var links = [
				["fd", "fdPtr"],
				["bk", "bkPtr"],
				["fdNextSize", "fdNextSize"],
				["bkNextSize", "bkNextSize"]
			];
			for(var linkIndex = 0; linkIndex < links.length; linkIndex++) {
				var link = links[linkIndex];
				if(currentChunk[link[0]] == checkChunk.address) {
					edges += `${chunkNodeId(currentChunk)}:${link[1]} -> ${chunkNodeId(checkChunk)}:${pointAt}` + "\n";
				}
			}
				
	

		}
	
	}	

	return edges;	
}

function findChunkByAddress(address) {
	var target = hInt(address);
	if(Number.isNaN(target) || target === 0) { return null; }
	for(var i = 0; i < hchunks.length; i++) {
		var chunkAddress = hInt(hchunks[i].address);
		if(target === chunkAddress) { return hchunks[i]; }
		// tcache bin entries are user pointers, while arena links use the
		// malloc_chunk header address.
		if(hchunks[i].bin.includes("tcache") && target === chunkAddress - hchunks[i].headerSize) { return hchunks[i]; }
	}
	return null;
}

function findStructureByAddress(address) {
	var target = hInt(address);
	if(Number.isNaN(target) || target === 0) { return null; }
	for(var i = 0; i < structures.length; i++) {
		if(target === hInt(structures[i].address)) {
			return {structure: structures[i], index: i};
		}
	}
	return null;
}

function makeManagementDot() {
	var dot = "\n// ptmalloc management structures\n";
	for(var i = 0; i < structures.length; i++) {
		var structure = structures[i] || {};
		var nodeId = structureNodeId(structure, i);
		var fields = structure.fields || [];
		dot += `
			${nodeId} [
				shape = none;
				fontcolor=white;
				label=<<table color="#4c505c" bgcolor="#202a35" border="0" cellspacing="0">
				<tr border="0"><td colspan="3" bgcolor="#0b0d0e" border="1"><font color="#6ec6ff">${dotEscape(structure.label || structure.kind || "structure")}</font></td></tr>
				<tr border="0"><td colspan="3" border="1">@ ${dotEscape(structure.address || "None")} (${dotEscape(structure.source || "unknown")})</td></tr>`;
		for(var f = 0; f < fields.length; f++) {
			var field = fields[f] || {};
			var port = dotPort(field.name || `field_${f}`);
			dot += `<tr border="0"><td port="${port}" border="1">${dotEscape(field.name || "field")}</td><td colspan="2" border="1">${dotEscape(field.value)}</td></tr>`;
		}
		dot += `</table>>];\n`;
	}
	return dot;
}

function makeManagementEdgesDot() {
	var edges = "\n// management references\n";
	for(var i = 0; i < structures.length; i++) {
		var structure = structures[i] || {};
		var fields = structure.fields || [];
		for(var f = 0; f < fields.length; f++) {
			var field = fields[f] || {};
			if(!field.target) { continue; }
			var source = `${structureNodeId(structure, i)}:${dotPort(field.name || `field_${f}`)}`;
			var targetStructure = findStructureByAddress(field.target);
			if(targetStructure) {
				edges += `${source} -> ${structureNodeId(targetStructure.structure, targetStructure.index)}` + "\n";
				continue;
			}
			var targetChunk = findChunkByAddress(field.target);
			if(targetChunk) {
				var targetPort = targetChunk.bin.includes("tcache") ? "fdPtr" : "prevSize";
				edges += `${source} -> ${chunkNodeId(targetChunk)}:${targetPort}` + "\n";
			}
		}
	}
	return edges;
}


/*
* getChunksDot: Responsible for collecting all dot generatos onto full layout.
* Also handles general layout styling 
*/
function getChunksDot()  {

	var dot = "digraph bins {";

	var layoutDot = 
	`
	    edge [color="#9297a9"];		// edge color
	    graph [bgcolor="#0b0d0e"];  // svg background color
	    newrank = true;		// Same level rows
	    nodesep = 0.2;		// Spacing between chunks
	    rankdir=LR;			// Left to right (horizontal) orientation
	`;		


	var headsDot = makeHeadsDot();
	var edges = makeChunksEdgesDot();
	var managementDot = makeManagementDot();
	var managementEdges = makeManagementEdgesDot();

	// Get binDot for each non empty bin head
	var chunksDots = "";
	for(var head in binsheads) {
		chunksDots += makeBinDot(head.replace("head", ""));
	}


	dot += layoutDot + "\n";
	dot += headsDot + "\n";
	dot += managementDot + "\n";
	dot += chunksDots + "\n";
	dot += edges + managementEdges + "\n";
	dot += "}";

	return [[dot]];
}


/*
* getBinChunks: returns array of chunks in given bin
*/
function getBinChunks(bin) {
	var ret = [];
	for(var i = 0; i < hchunks.length; i++) {
		var chunk = hchunks[i];
		if(chunk.bin == bin) {
			ret.push(chunk);
		}
	}

	return ret;
}
