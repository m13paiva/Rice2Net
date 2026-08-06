// core-draw.js
// Data loading, metadata hydration, adjacency, filtering/reset, simulation, draw, main core helpers.

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

        nodes = json.nodes.map((n) => ({ ...n }));
        const nodeMap = new Map(nodes.map((n) => [String(n.id), n]));

        document.getElementById("loader-text").innerText = "LOADING JSON... 50%";
        if (progressBar) progressBar.style.width = "50%";

        links = json.edges
          .map((e) => ({
            source: nodeMap.get(String(e.source.id || e.source)),
            target: nodeMap.get(String(e.target.id || e.target)),
            weight: e.weight || 1,
          }))
          .filter((l) => l.source && l.target);

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
      const lines = text.split(/\r?\n/);

      const newEdges = [];
      const nodeSet = new Set();

      lines.forEach((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) return;
        if (parts[0].toLowerCase() === "source") return;

        const s = parts[0];
        const t = parts[1];
        let w = 1;
        if (parts.length >= 3 && !isNaN(parseFloat(parts[2]))) {
          w = parseFloat(parts[2]);
        }

        newEdges.push({ source: s, target: t, weight: w });
        nodeSet.add(s);
        nodeSet.add(t);
      });

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
        }))
        .filter((l) => l.source && l.target);

      RAW_DATA.nodes = nodes;
      RAW_DATA.links = newEdges;
      RAW_DATA.adjacency = window.__APP_CORE__.buildAdjacency(nodes, links);

      await window.__APP_CORE__.hydrateMetadata();
      startCalculation(true);
    };
    reader.readAsText(input.files[0]);
  }, 50);
};

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

function updateVisualProps() {
  const base = parseFloat(document.getElementById("viz-base-size").value);
  const mult = parseFloat(document.getElementById("viz-size-mult").value);
  nodes.forEach((n) => {
    let degVal = Math.sqrt(n.deg || 0);
    n.r = base + degVal * mult;
  });
}

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
