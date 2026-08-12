// exporters.js
function isNodeVisibleForExport(node, targetSet = null) {
  if (!node) return false;
  if (node.isRogue && !VISIBILITY_STATE.Rogue) return false;

  const baseSpec = window.getTypeVisualSpec ? window.getTypeVisualSpec(node.originalType || "Gene") : { visibilityKey: "Gene" };
  if (VISIBILITY_STATE[baseSpec.visibilityKey] > 0) return true;

  if (CLUSTER_STATE.data.has(node.id)) {
    const clusterName = CLUSTER_STATE.data.get(node.id);
    if (CLUSTER_STATE.active.has(clusterName)) return true;
  }

  const resolvedTargetSet = targetSet || (typeof getExportTargetSet === 'function' ? getExportTargetSet() : new Set());
  if (VISIBILITY_STATE.Target > 0 && resolvedTargetSet.has(node.id)) return true;
  return false;
}

function getVisibleExportNodes() {
  const targetSet = typeof getExportTargetSet === 'function' ? getExportTargetSet() : new Set();
  return nodes.filter((n) => isNodeVisibleForExport(n, targetSet));
}

function getVisibleExportNodeMap() {
  return new Map(getVisibleExportNodes().map((n) => [n.id, n]));
}

function getVisibleExportLinks() {
  const visibleNodeMap = getVisibleExportNodeMap();
  return links.filter((l) => {
    if (window.isEdgeVisible && !window.isEdgeVisible(l)) return false;
    const sourceId = l.source?.id || l.source;
    const targetId = l.target?.id || l.target;
    return visibleNodeMap.has(sourceId) && visibleNodeMap.has(targetId);
  });
}

function getEdgeExportEndpoints(link) {
  const sourceNode = link.source;
  const targetNode = link.target;
  const priority = (node) => {
    switch (node?.originalType) {
      case "TF": return 3;
      case "Predicted TF": return 2;
      case "Predicted TR": return 1;
      default: return 0;
    }
  };
  return priority(targetNode) > priority(sourceNode) ? [targetNode, sourceNode] : [sourceNode, targetNode];
}

function downloadFile(content, filename, mimeType) {
  const a = document.createElement("a");
  const blob = new Blob([content], { type: mimeType });
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function initExportControls() {
  const tfOnlyRow = document.getElementById("export-tfs-only-row");
  if (tfOnlyRow) tfOnlyRow.remove();

  const tfOnly = document.getElementById("export-tfs-only");
  if (tfOnly) {
    const tfOnlyContainer = tfOnly.closest("label") || tfOnly.parentElement;
    if (tfOnlyContainer) tfOnlyContainer.remove();
    else tfOnly.remove();
  }

  const checkbox = document.getElementById("export-id-mode");
  const label = document.getElementById("export-id-mode-label");
  if (!checkbox) return;

  const syncLabel = () => {
    if (label) label.textContent = checkbox.checked ? "MSU IDs" : "RAP IDs";
  };
  syncLabel();

  if (checkbox.dataset.bound === "1") return;
  checkbox.addEventListener("change", syncLabel);
  checkbox.dataset.bound = "1";
}

window.exportTSV = function () {
  try {
    if (typeof window.reapplyColors === "function") window.reapplyColors();

    const isRegActive = window.isRegulationActive ? window.isRegulationActive() : (VISIBILITY_STATE.EdgeBoth ?? 0) > 0;
    const rows = ["Source\tTarget\tWeight\tIRP_score\tDirectional"];
    let exportedCount = 0;

    links.forEach((l) => {
      if (window.isEdgeVisible && !window.isEdgeVisible(l)) return;

      const sId = l.source?.id || l.source;
      const tId = l.target?.id || l.target;
      const sNode = typeof l.source === "object" ? l.source : nodes.find((n) => n.id === sId);
      const tNode = typeof l.target === "object" ? l.target : nodes.find((n) => n.id === tId);

      if (!sNode || !tNode) return;
      if ((sNode.isRogue && !VISIBILITY_STATE.Rogue) || sNode.color === CONFIG.visuals.colors.Transparent) return;
      if ((tNode.isRogue && !VISIBILITY_STATE.Rogue) || tNode.color === CONFIG.visuals.colors.Transparent) return;

      const weight = l.weight !== undefined ? l.weight : l.value || l.w || "1";
      const irpVal = l.irp !== undefined && l.irp !== null ? l.irp : "";

      const isDirectional = isRegActive && !!l.has_regulates && Array.isArray(l.directions) && l.directions.length > 0;

      if (isDirectional) {
        l.directions.forEach((dir) => {
          const dirSrcNode = nodes.find(n => n.id === dir.src);
          const dirTgtNode = nodes.find(n => n.id === dir.tgt);

          if (!dirSrcNode || !dirTgtNode) return;

          const sOut = window.getExportNodeId ? window.getExportNodeId(dirSrcNode) : dir.src;
          const tOut = window.getExportNodeId ? window.getExportNodeId(dirTgtNode) : dir.tgt;

          if (!sOut || !tOut) return;

          rows.push(`${sOut}\t${tOut}\t${weight}\t${irpVal}\ttrue`);
          exportedCount++;
        });
      } else {
        const sOut = window.getExportNodeId ? window.getExportNodeId(sNode) : sId;
        const tOut = window.getExportNodeId ? window.getExportNodeId(tNode) : tId;

        if (!sOut || !tOut) return;

        rows.push(`${sOut}\t${tOut}\t${weight}\t${irpVal}\tfalse`);
        exportedCount++;
      }
    });

    if (exportedCount === 0) { alert("No visible edges to export."); return; }

    const blob = new Blob([rows.join("\n")], { type: "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "network_edges.tsv";
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.log("Failed to export TSV:", e);
    alert("TSV Export failed. See console for your mess.");
  }
};

window.exportJSON = function () {
  try {
    if (typeof window.reapplyColors === "function") window.reapplyColors();

    const isRegActive = window.isRegulationActive ? window.isRegulationActive() : (VISIBILITY_STATE.EdgeBoth ?? 0) > 0;
    const exportNodes = [];
    const visibleNodeMap = new Set();

    nodes.forEach((n) => {
      if ((n.isRogue && !VISIBILITY_STATE.Rogue) || n.color === CONFIG.visuals.colors.Transparent) return;
      visibleNodeMap.add(n.id);
      exportNodes.push({
        id: window.getExportNodeId ? window.getExportNodeId(n) : n.id,
        x: Math.round(n.x * 100) / 100,
        y: Math.round(n.y * 100) / 100,
        deg: n.deg,
        originalType: n.originalType,
        isRogue: !!n.isRogue,
        symbol: n.symbol,
      });
    });

    if (exportNodes.length === 0) { alert("No visible nodes to export."); return; }

    const exportLinks = [];
    links.forEach((l) => {
      if (window.isEdgeVisible && !window.isEdgeVisible(l)) return;

      const sId = l.source?.id || l.source;
      const tId = l.target?.id || l.target;

      if (visibleNodeMap.has(sId) && visibleNodeMap.has(tId)) {
        const sNode = typeof l.source === "object" ? l.source : nodes.find((n) => n.id === sId);
        const tNode = typeof l.target === "object" ? l.target : nodes.find((n) => n.id === tId);

        exportLinks.push({
          source: window.getExportNodeId && sNode ? window.getExportNodeId(sNode) : sId,
          target: window.getExportNodeId && tNode ? window.getExportNodeId(tNode) : tId,
          weight: l.weight !== undefined ? l.weight : l.value || 1,
          irp: l.irp || 0,
          has_interacts: l.has_interacts,
          has_regulates: isRegActive ? !!l.has_regulates : false,
          matched_sequence: l.matched_sequence,
          p_value: l.p_value,
          q_value: l.q_value,
          score: l.score,
        });
      }
    });

    const payload = JSON.stringify({ nodes: exportNodes, edges: exportLinks }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "network_layout.json";
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.log("Failed to export JSON:", e);
    alert("JSON Export failed due to circular references or data corruption.");
  }
};

window.exportGenesTSV = async function () {
  try {
    if (typeof window.reapplyColors === "function") window.reapplyColors();

    const exportNodes = nodes.filter((n) => {
      if ((n.isRogue && !VISIBILITY_STATE.Rogue) || n.color === CONFIG.visuals.colors.Transparent) return false;
      return true;
    });

    if (exportNodes.length === 0) { alert("No visible genes to export."); return; }

    const loader = document.getElementById("loader");
    const loaderText = document.getElementById("loader-text");
    const progressBar = document.getElementById("progress-bar");

    if (loader && loaderText) {
      loader.style.display = "block";
      loaderText.innerText = "FETCHING GENE METADATA... 0%";
      if (progressBar) progressBar.style.width = "0%";
    }

    const batchSize = 50;
    const totalNodes = exportNodes.length;
    const totalBatches = Math.ceil(totalNodes / batchSize);

    for (let i = 0; i < totalNodes; i += batchSize) {
      const batch = exportNodes.slice(i, i + batchSize);
      await Promise.all(batch.map(async (n) => {
        try {
          const res = await fetch(`http://localhost:3000/api/network/node/${encodeURIComponent(n.id)}`);
          if (res.ok) {
            n.dbData = await res.json();
          }
        } catch (e) {
          console.warn(`Failed to fetch metadata for ${n.id}`);
        }
      }));

      if (loaderText && progressBar) {
        const currentBatch = Math.floor(i / batchSize) + 1;
        const pct = Math.round((currentBatch / totalBatches) * 100);
        loaderText.innerText = `FETCHING GENE METADATA... ${pct}%`;
        progressBar.style.width = `${pct}%`;
      }
    }

    const headers = [
      "Gene_ID", "Type", "Visual_Label", "Symbol", "MSU_ID", "Identifier",
      "Full_Name", "KEGG_Gene", "TF_Transcripts", "TF_Family", "GO_Terms",
      "KEGG_Pathways", "MapMan_Bins", "Uniprot_Entries", "KO"
    ];

    const rows = exportNodes.map((n) => {
      const row = [];
      row.push(window.getExportNodeId ? window.getExportNodeId(n) : n.id);
      row.push(n.originalType || "Gene");
      row.push(n.typeLabel || "Gene");

      const d = n.dbData || {};

      row.push(d.symbol || "");
      row.push(d.msu_id || "");
      row.push(d.identifier || "");
      row.push(d.full_name || "");
      row.push(d.kegg_gene || "");

      let tfIds = "", tfFams = "";
      if (d.tfDetail && d.tfDetail.length > 0) {
        tfIds = Array.from(new Set(d.tfDetail.map(tf => tf.id))).filter(Boolean).join(",");
        tfFams = Array.from(new Set(d.tfDetail.map(tf => tf.family))).filter(Boolean).join(",");
      }
      row.push(tfIds);
      row.push(tfFams);

      let goStr = "";
      if (d.attributes && d.attributes.GO && d.attributes.GO.length > 0) {
        goStr = Array.from(new Set(d.attributes.GO.map(g => g.id))).filter(Boolean).join(",");
      }
      row.push(goStr);

      let keggStr = "";
      if (d.keggDetail && d.keggDetail.length > 0) {
        keggStr = Array.from(new Set(d.keggDetail.map(k => k.code))).filter(Boolean).join(",");
      }
      row.push(keggStr);

      let mapmanStr = "";
      if (d.mapmanPaths && d.mapmanPaths.length > 0) {
        const bins = new Set();
        d.mapmanPaths.forEach(path => {
          path.forEach(node => { if(node.bincode) bins.add(node.bincode); });
        });
        mapmanStr = Array.from(bins).filter(Boolean).join(",");
      }
      row.push(mapmanStr);

      let uniprotStr = "";
      if (d.uniprotDetail && d.uniprotDetail.length > 0) {
        uniprotStr = Array.from(new Set(d.uniprotDetail.map(u => u.entry))).filter(Boolean).join(",");
      }
      row.push(uniprotStr);

      let koStr = "";
      if (d.attributes && d.attributes.KO && d.attributes.KO.length > 0) {
        koStr = Array.from(new Set(d.attributes.KO)).filter(Boolean).join(",");
      }
      row.push(koStr);

      return row.join("\t");
    });

    if (loader) loader.style.display = "none";

    const tsvContent = headers.join("\t") + "\n" + rows.join("\n");
    const blob = new Blob([tsvContent], { type: "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "genes_list.tsv";
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    if (document.getElementById("loader")) document.getElementById("loader").style.display = "none";
    console.log("Failed to export Genes TSV:", e);
    alert("Genes Export failed. See console for your mess.");
  }
};

window.exportPNG = function () {
  const loader = document.getElementById("loader");
  const loaderText = document.getElementById("loader-text");
  const progressBar = document.getElementById("progress-bar");

  if (loader && loaderText) {
    loader.style.display = "block";
    loaderText.innerText = "CRAFTING HIGH-RES EXPORT... 0%";
    if (progressBar) progressBar.style.width = "100%";
  }

  setTimeout(() => {
    try {
      const scale = 6;
      const exportCanvas = document.createElement("canvas");
      const exportCtx = exportCanvas.getContext("2d");

      const text = document.getElementById("target-input")?.value || "";
      const rawTargets = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const targetSet = window.resolveTargetIds ? window.resolveTargetIds(rawTargets) : new Set(rawTargets);

      const presentTypes = new Set();
      const presentClusters = new Set();
      let hasPresentTarget = false;
      const forceEdgeToggle = document.getElementById("export-force-edges");
      const forceShowEdges = forceEdgeToggle ? forceEdgeToggle.checked : false;

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let hasVisible = false;

      for (const n of nodes) {
        if (n.isRogue && !VISIBILITY_STATE.Rogue) continue;
        if (!forceShowEdges && n.color === CONFIG.visuals.colors.Transparent) continue;
        hasVisible = true;
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;

        const baseSpec = window.getTypeVisualSpec ? window.getTypeVisualSpec(n.originalType || "Gene") : { visibilityKey: "Gene" };
        presentTypes.add(baseSpec.visibilityKey);
        if (targetSet.has(n.id)) hasPresentTarget = true;
        if (CLUSTER_STATE.data.has(n.id)) presentClusters.add(CLUSTER_STATE.data.get(n.id));
      }

      if (!hasVisible) { minX = 0; maxX = 800; minY = 0; maxY = 600; }

      const marginPx = 40;
      const graphPixelW = (maxX - minX) * transform.k;
      const graphPixelH = (maxY - minY) * transform.k;

      const nodeItems = [];
      const addLegendItem = (arr, key, baseColor, label, shape, hollow) => {
        let st = VISIBILITY_STATE[key];
        if (st === true) st = 2;
        if (st === false) st = 0;
        if (st === 2 && presentTypes.has(key)) {
          arr.push({ color: baseColor, label: label, shape: shape, hollow: hollow, dashed: false });
        }
      };

      addLegendItem(nodeItems, "TF", CONFIG.visuals.colors.TF, "Transcription Factor", "diamond", false);
      addLegendItem(nodeItems, "PredictedTF", CONFIG.visuals.colors.Predicted, "Predicted TF", "diamond", false);
      addLegendItem(nodeItems, "PredictedTR", CONFIG.visuals.colors.Predicted, "Predicted TR", "diamond", true);

      let tgtSt = VISIBILITY_STATE.Target;
      if (tgtSt === true) tgtSt = 2;
      if (tgtSt === false) tgtSt = 0;
      const showTarget = document.getElementById("legend-target") && document.getElementById("legend-target").style.display !== "none";

      if (showTarget && tgtSt === 2 && hasPresentTarget) {
        nodeItems.push({ color: CONFIG.visuals.colors.Green, label: "Target Gene", shape: "circle", hollow: false, dashed: false });
      }

      addLegendItem(nodeItems, "AnnotatedGene", CONFIG.visuals.colors.AnnotatedGene, "Annotated Gene", "circle", true);
      addLegendItem(nodeItems, "Gene", CONFIG.visuals.colors.Gene, "Other Gene", "circle", true);

      const activeClusters = [...CLUSTER_STATE.legend]
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .filter((c) => CLUSTER_STATE.active.has(c.name) && presentClusters.has(c.name));

      const items = [];
      if (nodeItems.length > 0) {
        items.push({ isHeader: true, label: "Node legend" });
        items.push(...nodeItems);
      }
      if (activeClusters.length > 0) {
        items.push({ isHeader: true, label: "Cluster legend" });
        items.push(...activeClusters.map((c) => ({ color: c.color, label: c.name, shape: "square", hollow: false, dashed: false })));
      }

      const hasLegend = items.length > 0;
      const lw = 400;
      const legendPadding = 20;
      const headerFont = "bold 16px Segoe UI, sans-serif";
      const itemFont = "15px Segoe UI, sans-serif";
      const lineHeight = 22;
      const itemSpacing = 14;
      const maxTextWidth = lw - 80;

      let totalLegendHeight = legendPadding;
      items.forEach((item) => {
        exportCtx.font = item.isHeader ? headerFont : itemFont;
        const words = item.label.split(" ");
        let currentLine = "";
        const lines = [];

        words.forEach((word) => {
          const testLine = currentLine + (currentLine ? " " : "") + word;
          const metrics = exportCtx.measureText(testLine);
          if (metrics.width > maxTextWidth && currentLine !== "") {
            lines.push(currentLine);
            currentLine = word;
          } else {
            currentLine = testLine;
          }
        });
        if (currentLine) lines.push(currentLine);
        item.lines = lines;

        if (item.isHeader) item.height = lines.length * lineHeight + itemSpacing + 8;
        else item.height = Math.max(20, lines.length * lineHeight) + itemSpacing;
        totalLegendHeight += item.height;
      });
      totalLegendHeight += legendPadding;

      const lh = hasLegend ? Math.max(150, totalLegendHeight) : 0;
      const legendTotalWidth = hasLegend ? lw : 0;
      const targetW = graphPixelW + marginPx * 2;
      const targetH = graphPixelH + marginPx * 2;
      const finalW = targetW + legendTotalWidth + (hasLegend ? marginPx : 0);
      const finalH = Math.max(targetH, lh + marginPx * 2);

      exportCanvas.width = finalW * scale;
      exportCanvas.height = finalH * scale;
      exportCtx.fillStyle = THEME === "dark" ? "#1a1a1a" : "#ffffff";
      exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

      exportCtx.save();
      exportCtx.scale(scale, scale);

      // --- GRAPH ---
      exportCtx.save();
      const graphOffsetY = (finalH - graphPixelH) / 2;
      const graphOffsetX = marginPx;
      exportCtx.translate(graphOffsetX - minX * transform.k, graphOffsetY - minY * transform.k);
      exportCtx.scale(transform.k, transform.k);

      const edgeW = parseFloat(document.getElementById("viz-edge-width")?.value) || 0.3;
      const edgeA = parseFloat(document.getElementById("viz-edge-alpha")?.value) || 0.5;
      const finalAlpha = THEME === "light" ? Math.min(1.0, edgeA * 2.0) : edgeA;

      exportCtx.lineWidth = Math.max(edgeW / transform.k, edgeW);

      links.forEach((l) => {
        if (l.source?.x !== undefined) {
          const isSourceVisible = l.source.color !== CONFIG.visuals.colors.Transparent;
          const isTargetVisible = l.target.color !== CONFIG.visuals.colors.Transparent;
          if (!forceShowEdges && (!isSourceVisible || !isTargetVisible)) return;
          if ((l.source.isRogue || l.target.isRogue) && !VISIBILITY_STATE.Rogue) return;

          const isVisible = window.isEdgeVisible ? window.isEdgeVisible(l) : true;
          if (!isVisible) return;

          const isRegActive = window.isRegulationActive ? window.isRegulationActive() : (VISIBILITY_STATE.EdgeBoth ?? 0) > 0;
          const hasInt = l.has_interacts !== false;
          const hasReg = !!(l.has_regulates && Array.isArray(l.directions) && l.directions.length > 0);
          const isThisRegActive = isRegActive && hasReg;

          if (isThisRegActive) {
            exportCtx.strokeStyle = `rgba(${CONFIG.visuals.colors.EdgeRGB}, 1.0)`;
            if (window.drawArrow) {
              l.directions.forEach(dir => {
                let srcNode = String(l.source.id) === dir.src ? l.source : l.target;
                let tgtNode = String(l.target.id) === dir.tgt ? l.target : l.source;
                window.drawArrow(exportCtx, srcNode.x, srcNode.y, tgtNode.x, tgtNode.y, tgtNode.r || 5, !hasInt, 1.0);
              });
            }
          } else {
            const currentAlpha = isRegActive ? finalAlpha * 0.4 : finalAlpha;
            exportCtx.strokeStyle = `rgba(${CONFIG.visuals.colors.EdgeRGB}, ${currentAlpha})`;
            exportCtx.beginPath(); exportCtx.moveTo(l.source.x, l.source.y); exportCtx.lineTo(l.target.x, l.target.y); exportCtx.stroke();
          }
        }
      });

      for (const n of nodes) {
        if (n.isRogue && !VISIBILITY_STATE.Rogue) continue;
        if (n.color === CONFIG.visuals.colors.Transparent) continue;

        exportCtx.save();
        const isHollow = !!n.hollow;
        const isDashed = n.isRogue ? true : !!n.dashed;
        const strokeW = (isHollow ? 1.6 : 1) / transform.k;
        exportCtx.lineWidth = strokeW;
        exportCtx.setLineDash(isDashed ? [4 / transform.k, 3 / transform.k] : []);

        exportCtx.beginPath();
        if (n.shape === "diamond") {
          const rNode = n.r * 1.2;
          exportCtx.moveTo(n.x, n.y - rNode); exportCtx.lineTo(n.x + rNode, n.y); exportCtx.lineTo(n.x, n.y + rNode); exportCtx.lineTo(n.x - rNode, n.y); exportCtx.closePath();
        } else {
          exportCtx.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
        }

        const fillColor = n.fillColor !== undefined ? n.fillColor : n.color;
        if (!isHollow && fillColor && fillColor !== CONFIG.visuals.colors.Transparent) {
          exportCtx.globalAlpha = n.isRogue ? CONFIG.visuals.rogueOpacity : 1.0;
          exportCtx.fillStyle = fillColor; exportCtx.fill(); exportCtx.globalAlpha = 1.0;
        }

        exportCtx.strokeStyle = n.strokeColor || n.color || "#000";
        exportCtx.stroke();
        exportCtx.restore();
      }
      exportCtx.setLineDash([]);
      exportCtx.restore();

      // --- LEGEND ---
      if (hasLegend) {
        const lx = targetW;
        const ly = (finalH - lh) / 2;
        exportCtx.fillStyle = THEME === "dark" ? "rgba(40,40,40,0.9)" : "rgba(245,245,245,0.9)";
        exportCtx.strokeStyle = THEME === "dark" ? "#555" : "#ccc";
        exportCtx.lineWidth = 1;
        exportCtx.fillRect(lx, ly, lw, lh); exportCtx.strokeRect(lx, ly, lw, lh);

        let currentY = ly + legendPadding;
        items.forEach((item) => {
          if (item.isHeader) {
            exportCtx.fillStyle = THEME === "dark" ? "#bbb" : "#555";
            exportCtx.font = headerFont; exportCtx.textAlign = "left"; exportCtx.textBaseline = "middle";
            item.lines.forEach((line, index) => {
              exportCtx.fillText(line.toUpperCase(), lx + 20, currentY + index * lineHeight + lineHeight / 2);
            });
            currentY += item.height;
          } else {
            exportCtx.fillStyle = THEME === "dark" ? "#eee" : "#333";
            exportCtx.font = itemFont; exportCtx.textAlign = "left"; exportCtx.textBaseline = "middle";
            const iconY = currentY + lineHeight / 2, iconX = lx + 30;

            exportCtx.save();
            exportCtx.lineWidth = item.hollow ? 2 : 1;
            exportCtx.setLineDash(item.dashed ? [4, 3] : []);
            exportCtx.beginPath();
            if (item.shape === "square") {
              exportCtx.rect(iconX - 6, iconY - 6, 12, 12);
            } else if (item.shape === "circle") {
              exportCtx.arc(iconX, iconY, 6, 0, Math.PI * 2);
            } else {
              const rLegend = 6;
              exportCtx.moveTo(iconX, iconY - rLegend); exportCtx.lineTo(iconX + rLegend, iconY); exportCtx.lineTo(iconX, iconY + rLegend); exportCtx.lineTo(iconX - rLegend, iconY); exportCtx.closePath();
            }
            if (!item.hollow) { exportCtx.fillStyle = item.color; exportCtx.fill(); }
            exportCtx.strokeStyle = item.color; exportCtx.stroke(); exportCtx.restore();

            item.lines.forEach((line, index) => { exportCtx.fillText(line, lx + 50, currentY + index * lineHeight + lineHeight / 2); });
            currentY += item.height;
          }
        });
      }
      exportCtx.restore();

      const url = exportCanvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = "network_view_highres.png";
      a.click();
    } catch (err) {
      console.log("Failed to generate high-res PNG:", err);
      alert("Browser memory limit exceeded. Your canvas is too massive for a 6x scale.");
    } finally {
      if (loader) loader.style.display = "none";
      if (typeof window.draw === "function") requestAnimationFrame(window.draw);
    }
  }, 50);
};

initExportControls();
window.addEventListener("load", initExportControls);
