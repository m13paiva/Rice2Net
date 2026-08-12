/**
 * interactions.js - User Mouse/Pointer Interaction & Detail View Module
 * 
 * Manages spatial edge hover detection, mouseover tooltips, click selection handlers,
 * node details panel, edge details panel (with TF-promoter binding events), and context menus.
 */

/**
 * Finds the closest visible edge near the target canvas coordinates.
 * @param {number} wx - World X coordinate.
 * @param {number} wy - World Y coordinate.
 * @param {number} threshold - Hit test distance threshold.
 * @returns {Object|null} Closest hovered edge or null.
 */
function getHoveredEdge(wx, wy, threshold) {
  let closestEdge = null;
  let minDistSq = threshold * threshold;

  const isRegActive = window.isRegulationActive ? window.isRegulationActive() : (VISIBILITY_STATE.EdgeBoth ?? 0) > 0;

  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    const isVisible = window.isEdgeVisible ? window.isEdgeVisible(l) : true;
    if (!isVisible) continue;

    if (!l.source.x || !l.target.x) continue;
    if (l.source.color === CONFIG.visuals.colors.Transparent || l.target.color === CONFIG.visuals.colors.Transparent) continue;
    if (l.source.isRogue && !VISIBILITY_STATE.Rogue) continue;
    if (l.target.isRogue && !VISIBILITY_STATE.Rogue) continue;

    const sx = l.source.x, sy = l.source.y;
    const tx = l.target.x, ty = l.target.y;

    const minBoundX = Math.min(sx, tx) - threshold - 10;
    const maxBoundX = Math.max(sx, tx) + threshold + 10;
    if (wx < minBoundX || wx > maxBoundX) continue;

    const minBoundY = Math.min(sy, ty) - threshold - 10;
    const maxBoundY = Math.max(sy, ty) + threshold + 10;
    if (wy < minBoundY || wy > maxBoundY) continue;

    const l2 = (sx - tx) ** 2 + (sy - ty) ** 2;
    let dSq = Infinity;
    let tempClickedSrc = null;
    let tempClickedTgt = null;

    const isThisRegActive = isRegActive && !!(l.has_regulates && l.directions && l.directions.length > 0);

    if (isThisRegActive && l.directions.length > 1) {
        const offsetDist = 6 / transform.k;
        const dx = tx - sx;
        const dy = ty - sy;
        const len = Math.sqrt(l2);

        if (len > 0) {
            const nx = (-dy / len) * offsetDist;
            const ny = (dx / len) * offsetDist;

            const s1x = sx + nx, s1y = sy + ny;
            const t1x = tx + nx, t1y = ty + ny;
            let t1 = ((wx - s1x) * (t1x - s1x) + (wy - s1y) * (t1y - s1y)) / l2;
            t1 = Math.max(0, Math.min(1, t1));
            const dSq1 = (wx - (s1x + t1 * (t1x - s1x))) ** 2 + (wy - (s1y + t1 * (t1y - s1y))) ** 2;

            const s2x = sx - nx, s2y = sy - ny;
            const t2x = tx - nx, t2y = ty - ny;
            let t2 = ((wx - s2x) * (t2x - s2x) + (wy - s2y) * (t2y - s2y)) / l2;
            t2 = Math.max(0, Math.min(1, t2));
            const dSq2 = (wx - (s2x + t2 * (t2x - s2x))) ** 2 + (wy - (s2y + t2 * (t2y - s2y))) ** 2;

            if (dSq1 < dSq2) {
                dSq = dSq1;
                tempClickedSrc = String(l.source.id);
                tempClickedTgt = String(l.target.id);
            } else {
                dSq = dSq2;
                tempClickedSrc = String(l.target.id);
                tempClickedTgt = String(l.source.id);
            }
        }
    } else {
        if (l2 === 0) {
            dSq = (wx - sx) ** 2 + (wy - sy) ** 2;
        } else {
            let t = ((wx - sx) * (tx - sx) + (wy - sy) * (ty - sy)) / l2;
            t = Math.max(0, Math.min(1, t));
            dSq = (wx - (sx + t * (tx - sx))) ** 2 + (wy - (sy + t * (ty - sy))) ** 2;
        }

        if (isThisRegActive && l.directions.length === 1) {
            tempClickedSrc = l.directions[0].src;
            tempClickedTgt = l.directions[0].tgt;
        }
    }

    if (dSq < minDistSq) {
        minDistSq = dSq;
        closestEdge = l;
        closestEdge.clicked_src = tempClickedSrc;
        closestEdge.clicked_tgt = tempClickedTgt;
    }
  }
  return closestEdge;
}

let edgeHoverTimer = null;

/**
 * Handles mouse movement events in select mode, displaying node/edge tooltips.
 * @param {MouseEvent} event - Mouse movement event.
 */
function onMouseMoveSelect(event) {
  if (!quadtree) return;
  const [mx, my] = d3.pointer(event);
  const wx = (mx - transform.x) / transform.k;
  const wy = (my - transform.y) / transform.k;

  clearTimeout(edgeHoverTimer);
  const tooltip = document.getElementById("tooltip");
  const node = quadtree.find(wx, wy, 10 / transform.k + 5);
  let needsRedraw = false;

  if (node && node.color !== CONFIG.visuals.colors.Transparent) {
    if (typeof HOVERED_EDGE !== "undefined" && HOVERED_EDGE !== null) {
      HOVERED_EDGE = null;
      needsRedraw = true;
    }
    canvas.classList.add("hovering");
    tooltip.style.display = "flex";
    tooltip.style.left = mx + "px";
    tooltip.style.top = my + "px";
    const shapeClass = node.shape === "diamond" ? "tt-diamond" : "tt-circle";
    const ttBorder = `${node.hollow ? 2 : 1}px ${node.dashed ? "dashed" : "solid"} ${node.strokeColor || node.color}`;
    const ttBg = node.hollow ? "transparent" : node.color;
    tooltip.innerHTML = `
      <div class="tt-icon ${shapeClass}" style="background-color: ${ttBg}; border:${ttBorder};"></div>
      <span>${getNodeDisplayText(node)}</span>
    `;
    if (needsRedraw) requestAnimationFrame(window.draw);
  } else {
    if (typeof HOVERED_EDGE !== "undefined" && HOVERED_EDGE !== null) {
      HOVERED_EDGE = null;
      needsRedraw = true;
    }
    if (tooltip.style.display !== "none") {
      tooltip.style.display = "none";
      canvas.classList.remove("hovering");
    }
    if (needsRedraw) requestAnimationFrame(window.draw);

    const triggerEdgeHover = () => {
      const edgeThreshold = 10 / transform.k + 5;
      const edge = getHoveredEdge(wx, wy, edgeThreshold);
      if (edge) {
        HOVERED_EDGE = edge;

        const isRegActive = window.isRegulationActive ? window.isRegulationActive() : (VISIBILITY_STATE.EdgeBoth ?? 0) > 0;
        let ttext = `${edge.source.id} &mdash; ${edge.target.id}`;
        if (isRegActive && edge.has_regulates && edge.clicked_src && edge.clicked_tgt) {
            ttext = `${edge.clicked_src} &rarr; ${edge.clicked_tgt}`;
        }

        canvas.classList.add("hovering");
        tooltip.style.display = "flex";
        tooltip.style.left = mx + "px";
        tooltip.style.top = my + "px";
        tooltip.innerHTML = `
          <div class="tt-icon" style="background-color: #888; border-radius: 2px; width: 12px; height: 4px; margin-right: 8px;"></div>
          <span>${ttext}</span>
        `;
        requestAnimationFrame(window.draw);
      }
    };

    if (window.isHeavyGraph && window.isHeavyGraph()) {
      edgeHoverTimer = setTimeout(triggerEdgeHover, 1000);
    } else {
      triggerEdgeHover();
    }
  }
}

/**
 * Returns formatted display text for a node (symbol and ID).
 * @param {Object} node - Node object.
 * @returns {string} Formatted node display string.
 */
function getNodeDisplayText(node) {
  const identifier = (node && (node.identifier || (node.metadata && node.metadata.identifier)));
  if (identifier && identifier.trim() !== "" && identifier !== ".") return identifier;

  const rawSymbol = (node && (node.symbol || (node.metadata && node.metadata.symbol))) || "";
  const symbol = String(rawSymbol).trim();
  if (!symbol || symbol === "." || symbol === node.id) return node.id;
  return `${symbol} (${node.id})`;
}

/**
 * Handles click events on the canvas in select mode to show node/edge detail panels.
 * @param {MouseEvent} event - Click event object.
 */
function onClickSelect(event) {
  if (!quadtree) return;
  const [mx, my] = d3.pointer(event);
  const wx = (mx - transform.x) / transform.k;
  const wy = (my - transform.y) / transform.k;
  const node = quadtree.find(wx, wy, 10 / transform.k + 5);

  if (node && node.color !== CONFIG.visuals.colors.Transparent) {
    showNodeDetails(node);
  } else {
    const edgeThreshold = 10 / transform.k + 5;
    const edge = getHoveredEdge(wx, wy, edgeThreshold);
    if (edge) showEdgeDetails(edge);
  }
}

/**
 * Programmatically selects a node by ID and opens its detail panel.
 * @param {string} id - Target node ID.
 */
window.selectNode = function (id) {
  const node = nodes.find((n) => n.id === id);
  if (node) showNodeDetails(node);
};

/**
 * Closes active detail modal boxes and overlays.
 */
window.closeDetails = function () {
  document.getElementById("detail-box").style.display = "none";
  document.getElementById("detail-overlay").style.display = "none";
};

window.getNodeDisplayText = getNodeDisplayText;

function applyDynamicDetailBoxStyles() {
  if (!document.getElementById("dynamic-detail-style")) {
    const style = document.createElement("style");
    style.id = "dynamic-detail-style";
    style.innerHTML = `#detail-box { height: fit-content !important; max-height: 85vh !important; }`;
    document.head.appendChild(style);
  }
}

/**
 * Displays details for a selected edge link, fetching TF-promoter binding events when regulation mode is active.
 * @param {Object} edge - Selected edge link object.
 */
window.showEdgeDetails = async function (edge) {
  SELECTED_NODE = null;
  const detailBox = document.getElementById("detail-box");
  const detailContent = document.getElementById("detail-content");
  applyDynamicDetailBoxStyles();
  detailBox.style.display = "flex";
  document.getElementById("detail-overlay").style.display = "block";
  document.getElementById("tooltip").style.display = "none";

  const sNode = edge.source;
  const tNode = edge.target;

  const isRegActive = window.isRegulationActive ? window.isRegulationActive() : (VISIBILITY_STATE.EdgeBoth ?? 0) > 0;
  const isThisRegActive = isRegActive && !!(edge.has_regulates && edge.directions && edge.directions.length > 0);

  const reqSource = isThisRegActive ? (edge.clicked_src || (edge.directions && edge.directions.length > 0 ? edge.directions[0].src : sNode.id)) : sNode.id;
  const reqTarget = isThisRegActive ? (edge.clicked_tgt || (edge.directions && edge.directions.length > 0 ? edge.directions[0].tgt : tNode.id)) : tNode.id;

  const sourceObj = String(sNode.id) === String(reqSource) ? sNode : tNode;
  const targetObj = String(tNode.id) === String(reqTarget) ? tNode : sNode;

  const getIconHtml = (n) => {
    const bg = n.hollow ? "transparent" : n.fillColor || n.color;
    const border = n.strokeColor || n.color || "#fff";
    let style = `display:inline-block; width:12px; height:12px; background-color:${bg}; border: 2px ${n.dashed ? "dashed" : "solid"} ${border}; vertical-align:middle;`;
    if (n.shape === "diamond") style += ` transform: rotate(45deg); margin: 0 4px;`;
    else style += ` border-radius:50%; margin: 0 4px;`;
    return `<div style="${style}"></div>`;
  };

  let directionMarker = `
    <svg width="60" height="12" style="vertical-align: middle; margin: 0 5px;">
      <line x1="0" y1="6" x2="60" y2="6" stroke="#888" stroke-width="2"/>
    </svg>
  `;

  if (isThisRegActive) {
      directionMarker = `
        <svg width="60" height="12" style="vertical-align: middle; margin: 0 5px;">
          <defs>
            <marker id="detail-arrowhead" markerWidth="6" markerHeight="4" refX="5" refY="2" orient="auto">
              <polygon points="0 0, 6 2, 0 4" fill="#888" />
            </marker>
          </defs>
          <line x1="0" y1="6" x2="54" y2="6" stroke="#888" stroke-width="2" marker-end="url(#detail-arrowhead)"/>
        </svg>
      `;
  }

  document.getElementById("d-id").innerHTML = `
    <div style="display:flex; align-items:center; justify-content:center; gap:8px; font-size:1.1rem; width: 100%;">
      <span style="font-weight:bold; margin-right:5px;">Edge</span>
      <span style="cursor:pointer; color:#4db8ff; text-decoration:none;" onclick="window.selectNode('${sourceObj.id}')" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${getIconHtml(sourceObj)} ${sourceObj.id}</span>
      <span>${directionMarker}</span>
      <span style="cursor:pointer; color:#4db8ff; text-decoration:none;" onclick="window.selectNode('${targetObj.id}')" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${getIconHtml(targetObj)} ${targetObj.id}</span>
    </div>`;

  const weight = edge.weight !== undefined ? edge.weight : "1";
  const irp = edge.irp !== undefined && edge.irp !== null ? edge.irp : "-";

  if (isThisRegActive) {
    detailContent.innerHTML = `
      <div class="detail-row" style="margin-top: 15px;"><div class="detail-label">Weight</div><div class="detail-value">${weight}</div></div>
      <div class="detail-row"><div class="detail-label">IRP Score</div><div class="detail-value">${irp}</div></div>
      <div id="binds-container" style="margin-top: 15px;"></div>
    `;

    const bindsContainer = document.getElementById("binds-container");
    bindsContainer.innerHTML = `<div style="text-align:center; padding:10px; color:#aaa;">Fetching detailed binding events...</div>`;

    try {
      const response = await fetch(`http://localhost:3000/api/network/edges/binds?source=${encodeURIComponent(reqSource)}&target=${encodeURIComponent(reqTarget)}`);

      if (!response.ok) throw new Error("Failed to fetch binds");
      const { binds } = await response.json();

      if (binds && binds.length > 0) {

        const getInt = (val) => {
            if (val === null || val === undefined) return null;
            if (typeof val === 'object' && 'low' in val) return val.low;
            const parsed = parseInt(val, 10);
            return isNaN(parsed) ? null : parsed;
        };

        const sourcePriority = {
            "PlantTFDB": 1,
            "JASPAR Core": 2,
            "JASPAR Unvalidated": 3,
            "CIS-BP": 4
        };
        const getPriority = (src) => sourcePriority[src] || 99;

        const grouped = {};
        binds.forEach(m => {
            const mId = m.motif_id || "Unknown";
            if (!grouped[mId]) {
                grouped[mId] = { motif_id: mId, source: m.motif_source || "Unknown", entries: [] };
            }
            grouped[mId].entries.push(m);
        });

        const groupArray = Object.values(grouped).sort((a, b) => {
            const pA = getPriority(a.source);
            const pB = getPriority(b.source);
            if (pA !== pB) return pA - pB;
            return a.motif_id.localeCompare(b.motif_id);
        });

        groupArray.forEach(g => {
            g.entries.sort((a, b) => {
                const pA = parseFloat(a.p_value) || 0;
                const pB = parseFloat(b.p_value) || 0;
                return pA - pB;
            });
        });

        let tableHtml = `
          <div class="detail-row" style="border-top: 1px solid #444; padding-top: 10px;">
            <div class="detail-label" style="width:100%; text-align:center; margin-bottom:5px; color:#bbb;">TF-Promoter Binding Events</div>
          </div>
          <div style="max-height:250px; overflow-y:auto; border:1px solid #333; border-radius:4px; background:rgba(0,0,0,0.2);">
            <table style="width:100%; border-collapse:collapse; font-size:0.8rem; color:#eee; text-align:left;">
              <thead>
                <tr style="border-bottom:1px solid #555; background:rgba(255,255,255,0.05);">
                  <th style="padding:4px;">Motif ID</th>
                  <th style="padding:4px;">Source</th>
                  <th style="padding:4px;">Matched Sequence</th>
                  <th style="padding:4px;">Strand</th>
                  <th style="padding:4px;">Position</th>
                  <th style="padding:4px;">P value</th>
                  <th style="padding:4px;">Q value</th>
                  <th style="padding:4px;">Occurrence</th>
                </tr>
              </thead>
              <tbody>
        `;

        const formatSci = (v) => {
          if (v === null || v === undefined) return "-";
          const num = parseFloat(v);
          if (num === 0) return "0";
          const exp = Math.floor(Math.log10(num));
          if (exp <= -2) {
            const base = (num / Math.pow(10, exp)).toFixed(2);
            const superscripts = {
                '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
                '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻'
            };
            const expStr = String(exp).split('').map(c => superscripts[c] || c).join('');
            return `${base}x10${expStr}`;
          }
          return num.toString();
        };

        groupArray.forEach(g => {
            const rowCount = g.entries.length;
            g.entries.forEach((m, idx) => {
                const sLow = getInt(m.start);
                const eLow = getInt(m.stop);

                const startPos = sLow !== null ? sLow - 2000 : null;
                const stopPos = eLow !== null ? eLow - 2000 : null;
                const pos = (startPos !== null && stopPos !== null) ? `[${startPos}, ${stopPos}]` : "-";

                tableHtml += `<tr style="border-bottom:1px solid #333;">`;

                if (idx === 0) {
                    tableHtml += `
                        <td rowspan="${rowCount}" style="padding:6px 4px; border-right:1px solid #444; vertical-align:middle;">${m.motif_id || "-"}</td>
                        <td rowspan="${rowCount}" style="padding:6px 4px; border-right:1px solid #444; vertical-align:middle;">${m.motif_source || "-"}</td>
                    `;
                }

                tableHtml += `
                  <td style="padding:6px 4px; font-family:monospace; word-break:break-all;">${m.matched_sequence || "-"}</td>
                  <td style="padding:6px 4px;">${m.strand || "-"}</td>
                  <td style="padding:6px 4px; white-space:nowrap;">${pos}</td>
                  <td style="padding:6px 4px; white-space:nowrap;">${formatSci(m.p_value)}</td>
                  <td style="padding:6px 4px; white-space:nowrap;">${formatSci(m.q_value)}</td>
                  <td style="padding:6px 4px; white-space:nowrap;">${m.occurrence !== undefined && m.occurrence !== null ? m.occurrence : "-"}</td>
                </tr>`;
            });
        });

        tableHtml += `</tbody></table></div>`;
        bindsContainer.innerHTML = tableHtml;
      } else {
        bindsContainer.innerHTML = `<div style="text-align:center; padding:10px; color:#888;">No detailed binding events found.</div>`;
      }
    } catch (err) {
      console.error(err);
      bindsContainer.innerHTML = `<div style="text-align:center; padding:10px; color:#d9534f;">Failed to load binding data.</div>`;
    }
  } else {
    detailContent.innerHTML = `
      <div class="detail-row" style="margin-top: 15px;"><div class="detail-label">Weight</div><div class="detail-value">${weight}</div></div>
      <div class="detail-row"><div class="detail-label">IRP Score</div><div class="detail-value">${irp}</div></div>
    `;
  }
};

/**
 * Displays details modal panel for a selected node, fetching full attributes from the Neo4j API.
 * @param {Object} node - Selected node object.
 */
async function showNodeDetails(node) {
  SELECTED_NODE = node;
  const detailBox = document.getElementById("detail-box");
  const detailContent = document.getElementById("detail-content");
  applyDynamicDetailBoxStyles();
  detailBox.style.display = "flex";
  document.getElementById("detail-overlay").style.display = "block";

  const headerBg = node.hollow ? "transparent" : node.fillColor || node.color;
  const headerBorderColor = node.strokeColor || node.color || "#fff";
  let iconStyle = `display:inline-block; width:24px; height:24px; margin-right:15px; background-color:${headerBg}; border: 2px ${node.dashed ? "dashed" : "solid"} ${headerBorderColor};`;
  if (node.shape === "diamond") iconStyle += ` transform: rotate(45deg); margin-left:5px;`;
  else iconStyle += ` border-radius:50%;`;

  document.getElementById("d-id").innerHTML = `<div style="${iconStyle}"></div>${getNodeDisplayText(node)} <span style="font-size:0.8rem; color:#888;">(Loading metadata...)</span>`;
  detailContent.innerHTML = `<div style="text-align:center; padding:20px; color:#aaa;">Fetching details from Neo4j...</div>`;
  document.getElementById("tooltip").style.display = "none";

  try {
    const response = await fetch(`http://localhost:3000/api/network/node/${encodeURIComponent(node.id)}`);
    if (response.ok) {
      const dbData = await response.json();
      if (!node.metadata) node.metadata = {};
      node.metadata["RAP_ID"] = node.id;
      if (dbData.msu_id) node.metadata["MSU_ID"] = dbData.msu_id;
      if (dbData.identifier) node.identifier = dbData.identifier;
      if (dbData.kegg_gene) node.kegg_gene = dbData.kegg_gene;
      if (dbData.full_name) node.metadata["Description"] = dbData.full_name;

      if (dbData.attributes) {
        Object.keys(dbData.attributes).forEach((k) => {
          if (k === "GO") {
            node.goDetail = (dbData.attributes.GO || []).filter((g) => g && g.id && String(g.id).toLowerCase() !== "null");
          } else if (dbData.attributes[k] && dbData.attributes[k].length > 0) {
            const cleanValues = dbData.attributes[k].filter((v) => v && String(v).trim() !== "" && String(v).toLowerCase() !== "null" && String(v).toLowerCase() !== "none");
            if (cleanValues.length > 0) node.metadata[k] = cleanValues.join(", ");
          }
        });
      }
      node.keggDetail = (dbData.keggDetail || []).filter((k) => k && k.code && String(k.code).toLowerCase() !== "null");
      node.tfDetail = (dbData.tfDetail || []).filter((tf) => tf && tf.id && String(tf.id).toLowerCase() !== "null");
      node.mapmanPaths = dbData.mapmanPaths || [];
      if (dbData.uniprotDetail) {
        node.uniprotDetail = (dbData.uniprotDetail || []).filter(u => u && u.entry);
      }
    }
  } catch (error) {
    console.error("API Error:", error);
  }

  document.getElementById("d-id").innerHTML = `<div style="${iconStyle}"></div>${getNodeDisplayText(node)}`;

  let html = "";
  const fallbackSpec = window.getTypeVisualSpec ? window.getTypeVisualSpec(node.originalType || "Gene") : { label: node.originalType === "TF" ? "Transcription Factor" : "Gene" };

  html += `<div class="detail-row"><div class="detail-label">Type</div><div class="detail-value">${fallbackSpec.label}</div></div>`;

  if (typeof CLUSTER_STATE !== "undefined" && CLUSTER_STATE.isAvailable !== false && CLUSTER_STATE.data.has(node.id)) {
    const clusterName = CLUSTER_STATE.data.get(node.id);
    if (CLUSTER_STATE.active.has(clusterName)) {
        html += `<div class="detail-row"><div class="detail-label">Cluster</div><div class="detail-value">${clusterName}</div></div>`;
    }
  }

  const msuId = node.msu_id || (node.metadata && node.metadata["MSU_ID"]) || "-";
  html += `<div class="detail-row"><div class="detail-label">MSU ID</div><div class="detail-value">${msuId}</div></div>`;
  html += `<div class="detail-row"><div class="detail-label">RAP-DB ID</div><div class="detail-value">${node.id}</div></div>`;

  html += `<div style="width: 100%; height: 1px; background-color: #444; margin: 15px 0;"></div>`;

  if (Array.isArray(node.tfDetail) && node.tfDetail.length > 0) {
    const tfIds = node.tfDetail.map(tf => tf.id).join("<br>");
    const tfFamilies = Array.from(new Set(node.tfDetail.map(tf => tf.family || "Unknown"))).join("<br>");

    html += `<div class="detail-row" style="align-items:flex-start;"><div class="detail-label">TF Transcripts</div><div class="detail-value" style="font-size:1rem;">${tfIds}</div></div>`;
    html += `<div class="detail-row" style="align-items:flex-start; margin-top:5px;"><div class="detail-label">TF Family</div><div class="detail-value" style="font-size:1rem;">${tfFamilies}</div></div>`;
  }

  if (node.symbol && typeof node.symbol === "string" && node.symbol.trim() !== "-" && node.symbol.toLowerCase() !== "null") {
    const cleanedGenBank = node.symbol.replace(/\(?GenBank\)?/gi, "").trim();
    if (cleanedGenBank) {
      if (!node.metadata) node.metadata = {};
      node.metadata["GenBank"] = cleanedGenBank;
    }
  }

  const neighbors = RAW_DATA.adjacency.get(node.id) || [];
  if (neighbors.length > 0) {
    html += `
      <details style="margin-top:10px; border-bottom:1px solid #444; padding-bottom:10px; margin-bottom:15px;">
        <summary style="font-size:0.9rem; margin-bottom:5px; color:#bbb; cursor:pointer; outline:none;">CONNECTIONS (${node.deg || 0})</summary>
        <div style="max-height:150px; overflow-y:auto; border:1px solid #333; border-radius:4px; background:rgba(0,0,0,0.2);">
          <table style="width:100%; border-collapse:collapse; font-size:0.85rem; color:#eee;">
            <thead><tr style="border-bottom:1px solid #555; background:rgba(255,255,255,0.05);"><th style="text-align:left; padding:4px;">Node</th><th style="text-align:right; padding:4px;">Wgt</th><th style="text-align:right; padding:4px;">IRP</th></tr></thead>
            <tbody>`;
    neighbors.forEach((entry) => {
      const neighbor = nodes.find((n) => n.id === entry.n);
      if (!neighbor) return;
      const neighborBg = neighbor.hollow ? "transparent" : neighbor.fillColor || neighbor.color;
      let iconStyle2 = `display:inline-block; width:10px; height:10px; margin-right:6px; background-color:${neighborBg}; border:1px ${neighbor.dashed ? "dashed" : "solid"} ${neighbor.strokeColor || neighbor.color}; box-sizing:border-box;`;
      if (neighbor.shape === "diamond") iconStyle2 += ` transform: rotate(45deg); margin-left:2px; margin-right:8px;`;
      else iconStyle2 += ` border-radius:50%;`;
      const edge = links[entry.idx];
      const weight = edge ? edge.weight || edge.value || edge.w || "1" : "1";
      const irp = edge && edge.irp !== undefined && edge.irp !== null ? edge.irp : "-";
      html += `
        <tr style="border-bottom:1px solid #333; cursor:pointer;" onclick="window.selectNode('${neighbor.id}')" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='transparent'">
          <td style="padding:6px 4px;"><div style="${iconStyle2}"></div><span style="font-family:monospace;">${neighbor.id}</span></td>
          <td style="padding:6px 4px; text-align:right; opacity:0.7;">${weight}</td>
          <td style="padding:6px 4px; text-align:right; opacity:0.7;">${irp}</td>
        </tr>`;
    });
    html += `</tbody></table></div></details>`;
  }

  if (node.metadata) {
    Object.keys(node.metadata).sort().forEach((k) => {
      if (["TF_ID", "Family", "GO", "RAP_ID", "MSU_ID", "Symbol", "Identifier", "Description"].includes(k) || k.toUpperCase() === "GENE_ID" || k.toUpperCase() === "GENE ID") return;
      const val = String(node.metadata[k]).trim();
      if (!val || val === "" || val === "." || val.toLowerCase() === "null" || val.toLowerCase() === "none" || k.includes("Pathway") || k.startsWith("KEGG") || k.startsWith("KO")) return;
      html += `<div class="detail-row"><div class="detail-label">${k.replace(/_/g, " ")}</div><div class="detail-value" style="font-size:1rem;">${val}</div></div>`;
    });
  }

  if (Array.isArray(node.goDetail) && node.goDetail.length > 0) {
    html += `
      <details open style="margin-top:15px; border-top:1px solid #444; padding-top:10px;">
        <summary style="font-size:0.9rem; margin-bottom:10px; color:#bbb; cursor:pointer; outline:none;">GO TERMS</summary>
        <table style="width:100%; border-collapse:collapse; font-size:0.9rem; color:#eee;">
          <thead><tr style="border-bottom:1px solid #555;"><th style="text-align:left; padding:4px; color:#bbb;">ID</th><th style="text-align:left; padding:4px; color:#bbb;">Domain</th><th style="text-align:left; padding:4px; color:#bbb;">Description</th><th style="text-align:center; padding:4px; color:#bbb;">Actions</th></tr></thead>
          <tbody>`;
    node.goDetail.forEach((go) => {
      html += `
        <tr style="border-bottom:1px solid #333;">
          <td style="padding:6px 4px; font-family:monospace; color:#4db8ff; vertical-align:top;">${go.id || "-"}</td>
          <td style="padding:6px 4px; vertical-align:top;">${go.domain || "-"}</td>
          <td style="padding:6px 4px; vertical-align:top;">${go.name || "-"}</td>
          <td style="padding:6px 4px; text-align:center; vertical-align:top;"><a href="https://www.ebi.ac.uk/QuickGO/term/${go.id}" target="_blank" style="color:#eee; text-decoration:none;"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg></a></td>
        </tr>`;
    });
    html += `</tbody></table></details>`;
  }

  if (Array.isArray(node.mapmanPaths) && node.mapmanPaths.length > 0) {
    const mapmanTree = {};
    node.mapmanPaths.filter((path) => path && path.length > 0).forEach((path) => {
      let currentLevel = mapmanTree;
      [...path].reverse().forEach((step) => {
        if (!step || !step.bincode) return;
        if (!currentLevel[step.bincode]) currentLevel[step.bincode] = { ...step, children: {} };
        currentLevel = currentLevel[step.bincode].children;
      });
    });

    const buildTreeHTML = (treeNode) => {
      let innerHtml = "";
      Object.keys(treeNode).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach((k) => {
        const item = treeNode[k];
        const safeName = String(item.name || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const nodeStyle = "margin-left: 12px; border-left: 1px solid rgba(255,255,255,0.15); padding-left: 10px; margin-top: 4px;";
        if (Object.keys(item.children).length > 0) {
          innerHtml += `
            <details open style="${nodeStyle}">
              <summary style="cursor:pointer; outline:none; color:#bbb; font-size:0.85rem; padding: 2px 0; transition: color 0.2s;" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='#bbb'">
                  <span style="color:#4db8ff; font-family:monospace; margin-right:4px;">${item.bincode}</span><span style="font-family:sans-serif;">${safeName}</span>
              </summary>
              <div style="margin-top: 2px;">${buildTreeHTML(item.children)}</div>
            </details>`;
        } else {
          innerHtml += `<div style="${nodeStyle} font-size:0.85rem; color:#eee; padding: 2px 0; display:flex; align-items:flex-start;"><span style="color:#4db8ff; font-family:monospace; margin-right:4px;">${item.bincode}</span><span style="font-family:sans-serif;">${safeName}</span></div>`;
        }
      });
      return innerHtml;
    };
    html += `<details open style="margin-top:15px; border-top:1px solid #444; padding-top:10px;"><summary style="font-size:0.9rem; margin-bottom:10px; color:#bbb; cursor:pointer; outline:none;">MAPMAN ANNOTATIONS</summary><div style="background:rgba(0,0,0,0.2); border:1px solid #333; border-radius:4px; padding:8px; max-height:300px; overflow-y:auto; overflow-x:hidden;">${buildTreeHTML(mapmanTree)}</div></details>`;
  }

  if (window.KEGG && typeof window.KEGG.renderSection === "function" && Array.isArray(node.keggDetail) && node.keggDetail.length > 0) {
    html += window.KEGG.renderSection(node);
  }

  if (Array.isArray(node.uniprotDetail) && node.uniprotDetail.length > 0) {
    html += `
      <details open style="margin-top:15px; border-top:1px solid #444; padding-top:10px;">
        <summary style="font-size:0.9rem; margin-bottom:10px; color:#bbb; cursor:pointer; outline:none;">UNIPROT ENTRIES</summary>
        <div style="max-height:250px; overflow-y:auto; border:1px solid #333; border-radius:4px; background:rgba(0,0,0,0.2);">
        <table style="width:100%; border-collapse:collapse; font-size:0.85rem; color:#eee; text-align:left;">
          <thead>
            <tr style="border-bottom:1px solid #555; background:rgba(255,255,255,0.05);">
              <th style="padding:4px;">Entry</th>
              <th style="padding:4px;">Entry Name</th>
              <th style="padding:4px;">Gene Names</th>
              <th style="padding:4px;">Protein Names</th>
              <th style="padding:4px; text-align:center;">Reviewed</th>
            </tr>
          </thead>
          <tbody>`;
    node.uniprotDetail.forEach((u) => {
      const geneNames = u.gene_names ? String(u.gene_names).split(" ").join(", ") : "-";
      const proteinNames = u.protein_names ? String(u.protein_names).split(" ").join(", ") : "-";
      const reviewIcon = u.reviewed === "reviewed" ? "✔️" : "❌";
      html += `
        <tr style="border-bottom:1px solid #333;">
          <td style="padding:6px 4px;">${u.entry || "-"}</td>
          <td style="padding:6px 4px;">${u.entry_name || "-"}</td>
          <td style="padding:6px 4px;">${geneNames}</td>
          <td style="padding:6px 4px;">${proteinNames}</td>
          <td style="padding:6px 4px; text-align:center;">${reviewIcon}</td>
        </tr>`;
    });
    html += `</tbody></table></div></details>`;
  }

  detailContent.innerHTML = html;
}
window.showNodeDetails = showNodeDetails;

/**
 * Context menu handler for right-clicking nodes in select mode.
 */
canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const menu = document.getElementById('context-menu');
    if (!menu) return;

    if (window.IS_IMPORTED_NETWORK || CURRENT_MODE !== 'select' || !quadtree) {
        menu.style.display = 'none';
        return;
    }

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const wx = (mx - transform.x) / transform.k;
    const wy = (my - transform.y) / transform.k;
    const node = quadtree.find(wx, wy, 10 / transform.k + 5);

    if (node && node.color !== CONFIG.visuals.colors.Transparent && (!node.isRogue || VISIBILITY_STATE.Rogue)) {

        const uniqueNeighbors = new Map();
        nodes.forEach(n => uniqueNeighbors.set(String(n.id), new Set()));
        links.forEach(l => {
            const s = String(l.source.id || l.source);
            const t = String(l.target.id || l.target);
            if (s !== t) {
                if (uniqueNeighbors.has(s)) uniqueNeighbors.get(s).add(t);
                if (uniqueNeighbors.has(t)) uniqueNeighbors.get(t).add(s);
            }
        });

        const myId = String(node.id);
        const myNeighbors = uniqueNeighbors.get(myId) || new Set();

        const isLeaf = myNeighbors.size <= 1;

        let hasRemovableLeaves = false;
        myNeighbors.forEach(neighborId => {
            if (uniqueNeighbors.get(neighborId)?.size === 1) {
                hasRemovableLeaves = true;
            }
        });

        const fullNeighbors = new Set();
        if (RAW_DATA && RAW_DATA.links) {
            RAW_DATA.links.forEach(l => {
                const s = String(l.source.id || l.source);
                const t = String(l.target.id || l.target);
                if (s === myId && t !== myId) fullNeighbors.add(t);
                if (t === myId && s !== myId) fullNeighbors.add(s);
            });
        }

        const canExpand = fullNeighbors.size > myNeighbors.size;

        const expandBtn = document.getElementById('cm-expand');
        const contractBtn = document.getElementById('cm-contract');
        const popBtn = document.getElementById('cm-pop');

        if (expandBtn) expandBtn.style.display = canExpand ? "block" : "none";
        if (contractBtn) contractBtn.style.display = (!isLeaf && hasRemovableLeaves) ? "block" : "none";
        if (popBtn) popBtn.style.display = "block";

        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
        menu.style.display = 'block';
        menu.dataset.nodeId = node.id;
    } else {
        menu.style.display = 'none';
    }
});

document.addEventListener('click', (e) => {
    const menu = document.getElementById('context-menu');
    if (menu) menu.style.display = 'none';
});

/**
 * Handles context menu actions (expand, contract, pop).
 * @param {string} action - Context menu action identifier.
 */
window.handleContextMenuClick = function(action) {
    const menu = document.getElementById('context-menu');
    if (!menu) return;
    const nodeId = menu.dataset.nodeId;
    menu.style.display = 'none';

    if (!nodeId) return;

    if (action === 'contract' && typeof window.contractNode === "function") window.contractNode(nodeId);
    else if (action === 'expand' && typeof window.expandNode === "function") window.expandNode(nodeId);
    else if (action === 'pop' && typeof window.popNode === "function") window.popNode(nodeId);
};
