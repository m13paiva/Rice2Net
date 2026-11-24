/**
 * core.js - Secondary Network Bootstrapper & Import Module
 * 
 * Handles custom network graph imports (JSON, edge list TSVs), local subnetwork physics,
 * and fallback rendering helper definitions.
 */

/**
 * Imports a custom network layout structure from a user-uploaded JSON file.
 * @param {HTMLInputElement} input - File input element.
 */
window.importJSON = function (input) {
  if (!input.files || !input.files[0]) return;
  const fileName = input.files[0].name;

  const loader = document.getElementById("loader");
  const progressBar = document.getElementById("progress-bar");

  loader.style.display = "block";
  document.getElementById("loader-text").innerText = "LOADING JSON... 0%";
  if (progressBar) progressBar.style.width = "0%";

  setTimeout(() => {
    const reader = new FileReader();
    reader.onload = async function (e) {
      try {
        const json = JSON.parse(e.target.result);
        if (!json.nodes || !json.edges)
          throw new Error("Invalid JSON structure");

        window.IS_IMPORTED_NETWORK = true;
        if (typeof window.updateClusterAvailability === "function") window.updateClusterAvailability();

        const nameDisplay = document.getElementById('import-json-name');
        const infoDisplay = document.getElementById('import-json-info');
        if (nameDisplay && infoDisplay) {
            nameDisplay.innerText = fileName;
            infoDisplay.style.display = 'flex';
        }
        const edgesInfo = document.getElementById('import-edges-info');
        if (edgesInfo) edgesInfo.style.display = 'none';

        RAW_DATA.nodes = json.nodes;
        RAW_DATA.links = json.edges;

        nodes = json.nodes.map((n) => {
          const nodeObj = {
            ...n,
            identifier: n.identifier || (n.metadata && (n.metadata.Identifier || n.metadata.identifier)) || "",
            symbol: n.symbol || (n.metadata && (n.metadata.Symbol || n.metadata.symbol)) || "",
            msu_id: n.msu_id || (n.metadata && (n.metadata.MSU_ID || n.metadata.msu_id)) || "",
            originalType: n.originalType || n.type || "Gene",
            sign: n.sign || (n.metadata && n.metadata.Sign) || null,
            deg: n.deg !== undefined && n.deg !== null ? n.deg : 0,
          };
          if (typeof window.applyNodeTypeStyling === "function") {
            window.applyNodeTypeStyling(nodeObj);
          }
          return nodeObj;
        });
        const nodeMap = new Map();
        nodes.forEach((n) => {
          nodeMap.set(String(n.id), n);
          if (n.rap_id) nodeMap.set(String(n.rap_id), n);
          if (n.msu_id) {
            nodeMap.set(String(n.msu_id), n);
            nodeMap.set(String(n.msu_id).replace(/\.\d+$/, ""), n);
          }
        });

        document.getElementById("loader-text").innerText = "LOADING JSON... 50%";
        if (progressBar) progressBar.style.width = "50%";

        links = json.edges
          .map((e) => {
            const sId = String(e.source?.id || e.source);
            const tId = String(e.target?.id || e.target);
            const sNode = nodeMap.get(sId);
            const tNode = nodeMap.get(tId);
            if (!sNode || !tNode) return null;

            return {
              source: sNode,
              target: tNode,
              weight: e.weight !== undefined ? e.weight : (e.value || 1),
              irp: e.irp !== undefined && e.irp !== null ? e.irp : null,
              sign: e.sign || null,
              has_interacts: e.has_interacts !== false,
              has_regulates: !!e.has_regulates,
              directions: e.directions || (e.has_regulates ? [{ src: String(sNode.id), tgt: String(tNode.id) }] : null),
              binds: e.binds || null,
              reg_matched: !!e.has_regulates,
            };
          })
          .filter(Boolean);

        RAW_DATA.workingNodes = nodes;
        RAW_DATA.workingLinks = links;

        await window.__APP_CORE__.hydrateMetadata();
        RAW_DATA.adjacency = window.__APP_CORE__.buildAdjacency(nodes, links);

        if (loader) loader.style.display = "none";
        finishSetup(true);
      } catch (err) {
        alert("Error importing JSON: " + err.message);
        loader.style.display = "none";
      }
    };
    reader.readAsText(input.files[0]);
  }, 50);
};

/**
 * Imports custom edge links from a user-uploaded tabular TSV file.
 * @param {HTMLInputElement} input - File input element.
 */
window.importEdges = function (input) {
  if (!input.files || !input.files[0]) return;
  const fileName = input.files[0].name;

  const loader = document.getElementById("loader");
  const progressBar = document.getElementById("progress-bar");

  loader.style.display = "block";
  document.getElementById("loader-text").innerText = "READING EDGE TABLE... 0%";
  if (progressBar) progressBar.style.width = "0%";

  setTimeout(() => {
    const reader = new FileReader();
    reader.onload = async function (e) {
      document.getElementById("loader-text").innerText = "PARSING GRAPH... 50%";
      if (progressBar) progressBar.style.width = "50%";
      await sleep(10);

      window.IS_IMPORTED_NETWORK = true;
      if (typeof window.updateClusterAvailability === "function") window.updateClusterAvailability();

      const nameDisplay = document.getElementById('import-edges-name');
      const infoDisplay = document.getElementById('import-edges-info');
      if (nameDisplay && infoDisplay) {
          nameDisplay.innerText = fileName;
          infoDisplay.style.display = 'flex';
      }
      const jsonInfo = document.getElementById('import-json-info');
      if (jsonInfo) jsonInfo.style.display = 'none';

      const text = e.target.result;
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

      const edgeMap = new Map();
      const nodeSet = new Set();

      let colMap = {
        source: 0,
        target: 1,
        weight: 2,
        irp: -1,
        directional: -1,
        sign: -1,
        motif_id: -1,
        motif_source: -1,
        matched_sequence: -1,
        strand: -1,
        start: -1,
        stop: -1,
        score: -1,
        p_value: -1,
        q_value: -1,
        occurrence: -1,
      };

      let startIdx = 0;
      if (lines.length > 0 && lines[0].toLowerCase().includes("source")) {
        const headerParts = lines[0].trim().split(/\t/).map((h) => h.trim().toLowerCase());
        headerParts.forEach((h, idx) => {
          if (h === "source") colMap.source = idx;
          else if (h === "target") colMap.target = idx;
          else if (h === "weight") colMap.weight = idx;
          else if (h === "irp_score" || h === "irp") colMap.irp = idx;
          else if (h === "directional") colMap.directional = idx;
          else if (h === "sign") colMap.sign = idx;
          else if (h === "motif_id") colMap.motif_id = idx;
          else if (h === "motif_source") colMap.motif_source = idx;
          else if (h === "matched_sequence") colMap.matched_sequence = idx;
          else if (h === "strand") colMap.strand = idx;
          else if (h === "start") colMap.start = idx;
          else if (h === "stop") colMap.stop = idx;
          else if (h === "score") colMap.score = idx;
          else if (h === "p_value") colMap.p_value = idx;
          else if (h === "q_value") colMap.q_value = idx;
          else if (h === "occurrence") colMap.occurrence = idx;
        });
        startIdx = 1;
      }

      for (let i = startIdx; i < lines.length; i++) {
        const parts = lines[i].trim().split(/\t/);
        if (parts.length < 2) continue;

        const s = parts[colMap.source] ? parts[colMap.source].trim() : parts[0].trim();
        const t = parts[colMap.target] ? parts[colMap.target].trim() : parts[1].trim();
        if (!s || !t) continue;

        let w = 1;
        if (colMap.weight !== -1 && parts[colMap.weight] !== undefined) {
          const parsedW = parseFloat(parts[colMap.weight]);
          if (!isNaN(parsedW)) w = parsedW;
        } else if (parts.length >= 3 && !isNaN(parseFloat(parts[2]))) {
          w = parseFloat(parts[2]);
        }

        let irp = null;
        if (colMap.irp !== -1 && parts[colMap.irp] !== undefined) {
          const parsedIRP = parseFloat(parts[colMap.irp]);
          if (!isNaN(parsedIRP)) irp = parsedIRP;
        }

        let sign = null;
        if (colMap.sign !== -1 && parts[colMap.sign] !== undefined) {
          const rawSign = parts[colMap.sign].trim();
          if (rawSign === "+" || rawSign === "-") sign = rawSign;
        }

        let isDirectional = false;
        if (colMap.directional !== -1 && parts[colMap.directional] !== undefined) {
          isDirectional = parts[colMap.directional].trim().toLowerCase() === "true";
        }

        const edgeKey = `${s}->${t}`;
        if (!edgeMap.has(edgeKey)) {
          edgeMap.set(edgeKey, {
            source: s,
            target: t,
            weight: w,
            irp: irp,
            sign: sign,
            has_interacts: true,
            has_regulates: isDirectional,
            directions: isDirectional ? [{ src: s, tgt: t }] : null,
            binds: [],
            reg_matched: isDirectional,
          });
        }

        const edgeEntry = edgeMap.get(edgeKey);
        if (colMap.motif_id !== -1 && parts[colMap.motif_id] && parts[colMap.motif_id] !== "-") {
          edgeEntry.binds.push({
            motif_id: parts[colMap.motif_id] || "",
            motif_source: colMap.motif_source !== -1 ? parts[colMap.motif_source] || "" : "",
            matched_sequence: colMap.matched_sequence !== -1 ? parts[colMap.matched_sequence] || "" : "",
            strand: colMap.strand !== -1 ? parts[colMap.strand] || "" : "",
            start: colMap.start !== -1 && !isNaN(parseInt(parts[colMap.start], 10)) ? parseInt(parts[colMap.start], 10) : null,
            stop: colMap.stop !== -1 && !isNaN(parseInt(parts[colMap.stop], 10)) ? parseInt(parts[colMap.stop], 10) : null,
            score: colMap.score !== -1 && !isNaN(parseFloat(parts[colMap.score])) ? parseFloat(parts[colMap.score]) : null,
            p_value: colMap.p_value !== -1 && !isNaN(parseFloat(parts[colMap.p_value])) ? parseFloat(parts[colMap.p_value]) : null,
            q_value: colMap.q_value !== -1 && !isNaN(parseFloat(parts[colMap.q_value])) ? parseFloat(parts[colMap.q_value]) : null,
            occurrence: colMap.occurrence !== -1 && !isNaN(parseInt(parts[colMap.occurrence], 10)) ? parseInt(parts[colMap.occurrence], 10) : null,
          });
        }

        nodeSet.add(s);
        nodeSet.add(t);
      }

      const newEdges = Array.from(edgeMap.values());

      if (newEdges.length === 0) {
        alert("No valid edges found.");
        loader.style.display = "none";
        return;
      }

      nodes = Array.from(nodeSet).map((id) => ({
        id: id,
        deg: 0,
        x: random() * width,
        y: random() * height,
      }));

      const nodeMap = new Map(nodes.map((n) => [String(n.id), n]));
      links = newEdges
        .map((e) => ({
          source: nodeMap.get(String(e.source)),
          target: nodeMap.get(String(e.target)),
          weight: e.weight,
          irp: e.irp,
          sign: e.sign,
          has_interacts: e.has_interacts,
          has_regulates: e.has_regulates,
          directions: e.directions,
          binds: e.binds && e.binds.length > 0 ? e.binds : null,
          reg_matched: e.reg_matched,
        }))
        .filter((l) => l.source && l.target);

      RAW_DATA.nodes = nodes;
      RAW_DATA.links = newEdges;
      RAW_DATA.workingNodes = nodes;
      RAW_DATA.workingLinks = links;
      RAW_DATA.adjacency = window.__APP_CORE__.buildAdjacency(nodes, links);

      await window.__APP_CORE__.hydrateMetadata();
      startCalculation(true);
    };
    reader.readAsText(input.files[0]);
  }, 50);
};

/**
 * Calculates degrees for nodes in imported graphs.
 */
function calculateDegrees() {
  nodes.forEach((n) => (n.deg = 0));
  links.forEach((l) => {
    const s =
      typeof l.source === "object"
        ? l.source
        : nodes.find((n) => n.id === l.source);
    const t =
      typeof l.target === "object"
        ? l.target
        : nodes.find((n) => n.id === l.target);
    if (s) s.deg++;
    if (t) t.deg++;
  });
}

/**
 * Updates visual radius dimensions for imported nodes.
 */
function updateVisualProps() {
  const base = parseFloat(document.getElementById("viz-base-size").value);
  const mult = parseFloat(document.getElementById("viz-size-mult").value);
  nodes.forEach((n) => {
    let degVal = Math.sqrt(n.deg || 0);
    n.r = base + degVal * mult;
  });
}

/**
 * Updates physics simulation parameters for imported graphs.
 */
function updatePhysicsParams() {
  const rep = -parseInt(document.getElementById("phys-repulsion").value);
  const dist = parseInt(document.getElementById("phys-link-dist").value);
  const colMult = parseFloat(document.getElementById("phys-collision").value);
  const radStr = parseFloat(document.getElementById("phys-radial").value);
  if (simulation) {
    simulation
      .force("charge")
      .strength((d) => (!d.deg || d.deg <= 1 ? -1 : rep));
    simulation.force("link").distance(dist);
    simulation
      .force("radial")
      .x(width / 2)
      .y(height / 2)
      .strength(radStr);
    simulation.force("collide").radius((d) => d.r * colMult);
  }
}

/**
 * Runs localized D3 force simulation for a subset of affected node IDs.
 * @param {Array<string>} affectedIds - Node IDs allowed to move.
 */
window.runLocalPhysics = function (affectedIds) {
  if (!simulation) return;

  const affectedSet = new Set(affectedIds);

  nodes.forEach((n) => {
    if (!affectedSet.has(String(n.id))) {
      n.fx = n.x !== undefined ? n.x : width / 2;
      n.fy = n.y !== undefined ? n.y : height / 2;
    } else {
      n.fx = null;
      n.fy = null;
    }
  });

  calculateDegrees();
  updateVisualProps();
  updatePhysicsParams();

  simulation.nodes(nodes);
  simulation.force("link").links(links);

  simulation.on("tick", () => {
    requestAnimationFrame(window.draw);
  });

  simulation.on("end", () => {
    nodes.forEach((n) => {
      n.fx = null;
      n.fy = null;
    });
    simulation.on("tick", null);
    simulation.on("end", null);

    if (typeof d3 !== "undefined") {
        quadtree = d3.quadtree().x((d) => d.x).y((d) => d.y).addAll(nodes);
    }
  });

  simulation.alpha(0.5).restart();
};

/**
 * Runs layout calculation for imported graph topologies.
 * @param {boolean} resetParams - Reset parameters flag.
 */
function startCalculation(resetParams = true) {
  rng = mulberry32(_seed);
  nodes.forEach((n) => {
    if (n.x === undefined) n.x = random() * width;
    if (n.y === undefined) n.y = random() * height;
    n.vx = 0;
    n.vy = 0;
  });

  const loader = document.getElementById("loader");
  const loaderText = document.getElementById("loader-text");
  const progressBar = document.getElementById("progress-bar");

  loader.style.display = "block";
  if (loaderText) loaderText.innerText = "CALCULATING LAYOUT... 0%";
  if (progressBar) progressBar.style.width = "0%";

  if (simulation) simulation.stop();

  if (resetParams) {
    if (nodes.length > PERFORMANCE_LIMIT) {
      document.getElementById("phys-radial").value = "0.05";
      document.getElementById("phys-repulsion").value = "50";
      document.getElementById("viz-base-size").value = "0.5";
      document.getElementById("viz-size-mult").value = "0.8";
      document.getElementById("viz-edge-width").value = "0.1";
      document.getElementById("viz-edge-alpha").value = "0.15";
    } else {
      document.getElementById("phys-radial").value = "0.1";
      document.getElementById("phys-repulsion").value = "300";
      document.getElementById("viz-base-size").value = "2";
      document.getElementById("viz-size-mult").value = "2.5";
      document.getElementById("viz-edge-width").value = "0.3";
      document.getElementById("viz-edge-alpha").value = "0.5";
    }
  }

  calculateDegrees();
  updateVisualProps();
  updatePhysicsParams();

  simulation = d3
    .forceSimulation(nodes)
    .force("charge", d3.forceManyBody())
    .force(
      "link",
      d3.forceLink(links).id((d) => d.id),
    )
    .force("collide", d3.forceCollide())
    .force("radial", d3.forceRadial(0, width / 2, height / 2));

  updatePhysicsParams();

  ticksDone = 0;
  function step() {
    for (let i = 0; i < ticksPerFrame; i++) {
      simulation.tick();
      ticksDone++;
    }
    const pct = Math.min(100, (ticksDone / totalTicks) * 100);
    if (progressBar) progressBar.style.width = pct + "%";
    if (loaderText) loaderText.innerText = `CALCULATING LAYOUT... ${Math.round(pct)}%`;

    if (ticksDone < totalTicks) requestAnimationFrame(step);
    else {
      simulation.stop();
      loader.style.display = "none";
      quadtree = d3
        .quadtree()
        .x((d) => d.x)
        .y((d) => d.y)
        .addAll(nodes);
      window.autoFit && window.autoFit();
      finishSetup(resetParams);
    }
  }
  step();
}

/**
 * Fallback drawing routine for imported networks.
 */
window.draw = function () {
  ctx.save();
  ctx.fillStyle = THEME === "dark" ? "#1a1a1a" : "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);

  const isHeavy = nodes.length > PERFORMANCE_LIMIT;
  const simplify = CURRENT_MODE === "pan" && isHeavy && isInteracting;

  if (!simplify) {
    const edgeW = parseFloat(document.getElementById("viz-edge-width").value);
    const edgeA = parseFloat(document.getElementById("viz-edge-alpha").value);
    const finalAlpha = THEME === "light" ? Math.min(1.0, edgeA * 2.0) : edgeA;

    ctx.strokeStyle = `rgba(${CONFIG.visuals.colors.EdgeRGB}, ${finalAlpha})`;
    ctx.fillStyle = `rgba(${CONFIG.visuals.colors.EdgeRGB}, ${finalAlpha})`;
    ctx.lineWidth = Math.max(edgeW / transform.k, edgeW);

    const arrowSize = Math.max(6 / transform.k, 6);
    const offsetDist = 6 / transform.k;

    links.forEach((l) => {
      if (!l.source.x || !l.target.x) return;

      const validDirections = (l.has_regulates && Array.isArray(l.directions)) ? l.directions : [];
      const isBidirectional = validDirections.length > 1;

      if (!isBidirectional) {
        ctx.beginPath();
        ctx.moveTo(l.source.x, l.source.y);
        ctx.lineTo(l.target.x, l.target.y);
        ctx.stroke();
      }

      validDirections.forEach(dir => {
        let srcNode, tgtNode;

        if (String(l.source.id) === dir.src && String(l.target.id) === dir.tgt) {
          srcNode = l.source;
          tgtNode = l.target;
        } else if (String(l.target.id) === dir.src && String(l.source.id) === dir.tgt) {
          srcNode = l.target;
          tgtNode = l.source;
        } else {
          return;
        }

        let lineStartX = srcNode.x, lineStartY = srcNode.y;
        let lineEndX = tgtNode.x, lineEndY = tgtNode.y;
        const tgtR = tgtNode.r || 2;

        const dx = lineEndX - lineStartX;
        const dy = lineEndY - lineStartY;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) return;

        if (isBidirectional) {
          const nx = (-dy / len) * offsetDist;
          const ny = (dx / len) * offsetDist;
          lineStartX += nx; lineStartY += ny;
          lineEndX += nx; lineEndY += ny;

          ctx.beginPath();
          ctx.moveTo(lineStartX, lineStartY);
          ctx.lineTo(lineEndX, lineEndY);
          ctx.stroke();
        }

        const angle = Math.atan2(lineEndY - lineStartY, lineEndX - lineStartX);
        const targetEdgeX = lineEndX - tgtR * Math.cos(angle);
        const targetEdgeY = lineEndY - tgtR * Math.sin(angle);

        ctx.beginPath();
        ctx.moveTo(targetEdgeX, targetEdgeY);
        ctx.lineTo(targetEdgeX - arrowSize * Math.cos(angle - Math.PI / 6), targetEdgeY - arrowSize * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(targetEdgeX - arrowSize * Math.cos(angle + Math.PI / 6), targetEdgeY - arrowSize * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
      });
    });
  }

  if (simplify) {
    for (const n of nodes) {
      if (n.color === CONFIG.visuals.colors.Transparent) continue;
      ctx.fillStyle = n.color;
      ctx.fillRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
    }
  } else {
    for (const n of nodes) {
      if (n.color === CONFIG.visuals.colors.Transparent) continue;

      ctx.fillStyle = n.fillColor || n.color;
      ctx.strokeStyle = n.strokeColor || "#000";
      ctx.lineWidth = n.strokeWidth || (1 / transform.k);

      if (n.dashed) {
         ctx.setLineDash([3 / transform.k, 3 / transform.k]);
      } else {
         ctx.setLineDash([]);
      }

      ctx.beginPath();
      if (n.shape === "diamond") {
        const r = n.r * 1.2;
        ctx.moveTo(n.x, n.y - r);
        ctx.lineTo(n.x + r, n.y);
        ctx.lineTo(n.x, n.y + r);
        ctx.lineTo(n.x - r, n.y);
        ctx.closePath();
      } else {
        ctx.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
      }

      if (!n.hollow) ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
};

/**
 * Finalizes post-calculation setup for imported graph views.
 * @param {boolean} resetParams - Reset parameters flag.
 */
function finishSetup(resetParams) {
  document.getElementById("val-nodes").innerText =
    nodes.length.toLocaleString();
  document.getElementById("val-edges").innerText =
    links.length.toLocaleString();

  if (resetParams && nodes.length > PERFORMANCE_LIMIT) {
    document.getElementById("phys-radial").value = "0.05";
    document.getElementById("phys-repulsion").value = "50";
    document.getElementById("viz-base-size").value = "0.5";
    document.getElementById("viz-size-mult").value = "0.8";
    document.getElementById("viz-edge-width").value = "0.1";
    document.getElementById("viz-edge-alpha").value = "0.15";
  } else if (resetParams) {
    document.getElementById("phys-radial").value = "0.1";
    document.getElementById("phys-repulsion").value = "300";
    document.getElementById("viz-base-size").value = "2";
    document.getElementById("viz-size-mult").value = "2.5";
    document.getElementById("viz-edge-width").value = "0.3";
    document.getElementById("viz-edge-alpha").value = "0.5";
  }

  calculateDegrees();
  updateVisualProps();
  updatePhysicsParams();

  quadtree = d3
    .quadtree()
    .x((d) => d.x)
    .y((d) => d.y)
    .addAll(nodes);

  if (typeof window.setMode === "function") window.setMode("pan");
  if (typeof window.highlightCurrentView === "function")
    window.highlightCurrentView();

  setTimeout(() => window.autoFit && window.autoFit(), 100);
}
