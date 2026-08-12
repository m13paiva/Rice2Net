/**
 * sim.js - Force-Directed Layout Simulation & Canvas Rendering Module
 * 
 * Manages D3 force simulation physics, node degree calculation, dynamic visual sizing,
 * canvas element drawing (nodes, standard edges, directional regulation arrows), and auto-positioning.
 */

window.__APP_CORE__ = window.__APP_CORE__ || {};

/**
 * Calculates connected degrees for all active nodes.
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
 * Updates dynamic node radii based on node degree and base sizing parameters.
 */
function updateVisualProps() {
  const base = parseFloat(document.getElementById("viz-base-size").value);
  const mult = parseFloat(document.getElementById("viz-size-mult").value);
  nodes.forEach((n) => {
    const degVal = Math.sqrt(n.deg || 0);
    n.r = base + degVal * mult;
  });
}

/**
 * Updates D3 force simulation parameters (repulsion, link distance, collision, radial force).
 */
function updatePhysicsParams() {
  const rep = -parseInt(document.getElementById("phys-repulsion").value);
  const dist = parseInt(document.getElementById("phys-link-dist").value);
  const colMult = parseFloat(document.getElementById("phys-collision").value);
  const radStr = parseFloat(document.getElementById("phys-radial").value);

  const w = typeof width !== "undefined" ? width : window.innerWidth || 1000;
  const h = typeof height !== "undefined" ? height : window.innerHeight || 1000;

  if (simulation) {
    simulation
      .force("charge")
      .strength((d) => (!d.deg || d.deg <= 1 ? -1 : rep));
    simulation.force("link").distance(dist);
    simulation
      .force("radial")
      .x(w / 2)
      .y(h / 2)
      .strength(radStr);
    simulation.force("collide").radius((d) => d.r * colMult);
  }
}

/**
 * Starts layout calculation using D3 force simulation over a fixed frame step.
 * @param {boolean} resetParams - Whether to reset physics controls based on network size.
 */
function startCalculation(resetParams = true) {
  rng = mulberry32(_seed);

  const w = typeof width !== "undefined" ? width : window.innerWidth || 1000;
  const h = typeof height !== "undefined" ? height : window.innerHeight || 1000;

  nodes.forEach((n) => {
    if (n.x === undefined) n.x = random() * w;
    if (n.y === undefined) n.y = random() * h;
    n.vx = 0;
    n.vy = 0;
  });

  const loader = document.getElementById("loader");
  loader.style.display = "block";
  document.getElementById("loader-text").innerText = "CALCULATING LAYOUT...";
  document.getElementById("progress-bar").style.width = "0%";

  if (simulation) simulation.stop();

  if (resetParams) {
    if (window.isHeavyGraph()) {
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

  nodes.forEach((n) => {
    if (n.isRogue) {
      n.fx = w / 2;
      n.fy = h / 2;
    } else {
      n.fx = null;
      n.fy = null;
    }
  });

  simulation = d3
    .forceSimulation(nodes.filter((n) => !n.isRogue))
    .randomSource(random)
    .force("charge", d3.forceManyBody())
    .force(
      "link",
      d3.forceLink(links).id((d) => d.id),
    )
    .force("collide", d3.forceCollide())
    .force("radial", d3.forceRadial(0, w / 2, h / 2));

  updatePhysicsParams();

  ticksDone = 0;
  function step() {
    for (let i = 0; i < ticksPerFrame; i++) {
      simulation.tick();
      ticksDone++;
    }
    const pct = Math.min(100, (ticksDone / totalTicks) * 100);
    document.getElementById("progress-bar").style.width = pct + "%";

    if (ticksDone < totalTicks) requestAnimationFrame(step);
    else {
      simulation.stop();
      loader.style.display = "none";
      finishSetup(resetParams);
    }
  }
  step();
}

/**
 * Draws a directional regulation arrow between source and target coordinates.
 * @param {CanvasRenderingContext2D} ctx - Canvas context.
 * @param {number} sx - Source X coordinate.
 * @param {number} sy - Source Y coordinate.
 * @param {number} tx - Target X coordinate.
 * @param {number} ty - Target Y coordinate.
 * @param {number} tr - Target node radius.
 * @param {boolean} isDashed - Whether to draw a dashed line.
 * @param {number} alpha - Opacity value.
 */
window.drawArrow = function (ctx, sx, sy, tx, ty, tr, isDashed, alpha) {
  ctx.save();
  const dx = tx - sx,
    dy = ty - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < tr) {
    ctx.restore();
    return;
  }

  const angle = Math.atan2(dy, dx);
  const targetX = tx - Math.cos(angle) * (tr + 2);
  const targetY = ty - Math.sin(angle) * (tr + 2);

  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(targetX, targetY);
  if (isDashed) ctx.setLineDash([6 / transform.k, 4 / transform.k]);
  ctx.stroke();
  ctx.setLineDash([]);

  const headlen = Math.max(10 / transform.k, 6);
  ctx.beginPath();
  ctx.moveTo(targetX, targetY);
  ctx.lineTo(
    targetX - headlen * Math.cos(angle - Math.PI / 7),
    targetY - headlen * Math.sin(angle - Math.PI / 7),
  );
  ctx.lineTo(
    targetX - headlen * Math.cos(angle + Math.PI / 7),
    targetY - headlen * Math.sin(angle + Math.PI / 7),
  );
  ctx.lineTo(targetX, targetY);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
  ctx.restore();
};

/**
 * Master HTML5 Canvas drawing loop for nodes, links, and hover highlights.
 */
window.draw = function () {
  const w = typeof width !== "undefined" ? width : window.innerWidth || 1000;
  const h = typeof height !== "undefined" ? height : window.innerHeight || 1000;

  ctx.save();
  ctx.fillStyle = THEME === "dark" ? "#1a1a1a" : "#ffffff";
  ctx.fillRect(0, 0, w, h);

  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);

  const isHeavy = window.isHeavyGraph();
  const simplify = CURRENT_MODE === "pan" && isHeavy && isInteracting;

  if (!simplify) {
    const edgeW = parseFloat(document.getElementById("viz-edge-width").value);
    const edgeA = parseFloat(document.getElementById("viz-edge-alpha").value);
    const finalAlpha = THEME === "light" ? Math.min(1.0, edgeA * 2.0) : edgeA;
    const isRegActive = window.isRegulationActive ? window.isRegulationActive() : (VISIBILITY_STATE.EdgeBoth ?? 0) > 0;

    ctx.lineWidth = Math.max(edgeW / transform.k, edgeW);

    links.forEach((l) => {
      if (typeof HOVERED_EDGE !== "undefined" && l === HOVERED_EDGE) return;
      if (
        l.source &&
        l.source.x !== undefined &&
        l.source.color !== CONFIG.visuals.colors.Transparent &&
        l.target.color !== CONFIG.visuals.colors.Transparent
      ) {
        if ((l.source.isRogue || l.target.isRogue) && !VISIBILITY_STATE.Rogue)
          return;

        const isVisible = window.isEdgeVisible ? window.isEdgeVisible(l) : true;
        if (!isVisible) return;

        const hasInt = l.has_interacts !== false;
        const hasReg = !!(l.has_regulates && Array.isArray(l.directions) && l.directions.length > 0);
        const isThisRegActive = isRegActive && hasReg;

        if (isThisRegActive) {
           const isBidirectional = l.directions.length > 1;
           const offsetDist = 6 / transform.k;
           const isDashed = !hasInt;

           ctx.strokeStyle = `rgba(${CONFIG.visuals.colors.EdgeRGB}, 1.0)`;

           l.directions.forEach(dir => {
              let srcNode, tgtNode;
              if (String(l.source.id) === dir.src && String(l.target.id) === dir.tgt) {
                srcNode = l.source;
                tgtNode = l.target;
              } else if (String(l.target.id) === dir.src && String(l.source.id) === dir.tgt) {
                srcNode = l.target;
                tgtNode = l.source;
              } else return;

              let sx = srcNode.x, sy = srcNode.y;
              let tx = tgtNode.x, ty = tgtNode.y;

              if (isBidirectional) {
                 const dx = tx - sx;
                 const dy = ty - sy;
                 const len = Math.sqrt(dx * dx + dy * dy);
                 if (len > 0) {
                   const nx = (-dy / len) * offsetDist;
                   const ny = (dx / len) * offsetDist;
                   sx += nx; sy += ny;
                   tx += nx; ty += ny;
                 }
              }
              window.drawArrow(ctx, sx, sy, tx, ty, tgtNode.r || 5, isDashed, 1.0);
           });

        } else {
          const currentAlpha = isRegActive ? finalAlpha * 0.4 : finalAlpha;
          ctx.strokeStyle = `rgba(${CONFIG.visuals.colors.EdgeRGB}, ${currentAlpha})`;
          ctx.beginPath();
          ctx.moveTo(l.source.x, l.source.y);
          ctx.lineTo(l.target.x, l.target.y);
          ctx.stroke();
        }
      }
    });

    if (typeof HOVERED_EDGE !== "undefined" && HOVERED_EDGE) {
      ctx.save();
      const edgeStroke = THEME === "dark" ? "#ffffff" : "#000000";
      ctx.strokeStyle = edgeStroke;
      ctx.fillStyle = edgeStroke;
      ctx.lineWidth = Math.max((edgeW * 3) / transform.k, edgeW * 3);
      ctx.globalAlpha = 1.0;

      const l = HOVERED_EDGE;
      const hasInt = l.has_interacts !== false;
      const hasReg = !!(l.has_regulates && Array.isArray(l.directions) && l.directions.length > 0);
      const isThisRegActive = isRegActive && hasReg;

      if (isThisRegActive) {
         const isBidirectional = l.directions.length > 1;
         const offsetDist = 6 / transform.k;

         l.directions.forEach(dir => {
              let srcNode, tgtNode;
              if (String(l.source.id) === dir.src && String(l.target.id) === dir.tgt) {
                srcNode = l.source; tgtNode = l.target;
              } else if (String(l.target.id) === dir.src && String(l.source.id) === dir.tgt) {
                srcNode = l.target; tgtNode = l.source;
              } else return;

              let sx = srcNode.x, sy = srcNode.y;
              let tx = tgtNode.x, ty = tgtNode.y;

              if (isBidirectional) {
                 const dx = tx - sx;
                 const dy = ty - sy;
                 const len = Math.sqrt(dx * dx + dy * dy);
                 if (len > 0) {
                   const nx = (-dy / len) * offsetDist;
                   const ny = (dx / len) * offsetDist;
                   sx += nx; sy += ny;
                   tx += nx; ty += ny;
                 }
              }

              const isHoveredDir = (l.clicked_src === dir.src && l.clicked_tgt === dir.tgt);
              if (isHoveredDir) {
                  ctx.strokeStyle = edgeStroke;
                  ctx.fillStyle = edgeStroke;
                  ctx.lineWidth = Math.max((edgeW * 3) / transform.k, edgeW * 3);
              } else {
                  ctx.strokeStyle = `rgba(${CONFIG.visuals.colors.EdgeRGB}, 1.0)`;
                  ctx.fillStyle = `rgba(${CONFIG.visuals.colors.EdgeRGB}, 1.0)`;
                  ctx.lineWidth = Math.max(edgeW / transform.k, edgeW);
              }

              window.drawArrow(ctx, sx, sy, tx, ty, tgtNode.r || 5, !hasInt, 1.0);
         });
      } else {
        ctx.beginPath();
        ctx.moveTo(l.source.x, l.source.y);
        ctx.lineTo(l.target.x, l.target.y);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  if (simplify) {
    for (const n of nodes) {
      if (n.isRogue && !VISIBILITY_STATE.Rogue) continue;
      if (n.color === CONFIG.visuals.colors.Transparent) continue;

      ctx.globalAlpha = n.isRogue ? CONFIG.visuals.rogueOpacity : 1.0;
      ctx.fillStyle = n.color;
      ctx.fillRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
      ctx.globalAlpha = 1.0;
    }
  } else {
    for (const n of nodes) {
      if (n.isRogue && !VISIBILITY_STATE.Rogue) continue;
      if (n.color === CONFIG.visuals.colors.Transparent) continue;

      ctx.save();

      const isHollow = !!n.hollow;
      const isDashed = n.isRogue ? true : !!n.dashed;

      const strokeW = (isHollow ? 1.6 : 1) / transform.k;
      ctx.lineWidth = strokeW;
      ctx.setLineDash(isDashed ? [4 / transform.k, 3 / transform.k] : []);

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

      const fillColor = n.fillColor !== undefined ? n.fillColor : n.color;
      if (
        !isHollow &&
        fillColor &&
        fillColor !== CONFIG.visuals.colors.Transparent
      ) {
        ctx.globalAlpha = n.isRogue ? CONFIG.visuals.rogueOpacity : 1.0;
        ctx.fillStyle = fillColor;
        ctx.fill();
        ctx.globalAlpha = 1.0;
      }

      ctx.strokeStyle = n.strokeColor || n.color || "#000";
      ctx.stroke();
      ctx.restore();
    }
    ctx.setLineDash([]);
  }

  ctx.restore();
};

/**
 * Finalizes post-calculation setup, positioning rogue nodes along a peripheral ring.
 * @param {boolean} resetParams - Whether physics parameters were reset.
 */
function finishSetup(resetParams) {
  if (typeof window.updateActiveCounts === "function") {
    window.updateActiveCounts();
  } else {
    document.getElementById("val-nodes").innerText =
      nodes.length.toLocaleString();
    document.getElementById("val-edges").innerText =
      links.length.toLocaleString();
  }

  if (resetParams && window.isHeavyGraph()) {
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

  const w = typeof width !== "undefined" ? width : window.innerWidth || 1000;
  const h = typeof height !== "undefined" ? height : window.innerHeight || 1000;

  const connectedNodes = nodes.filter((n) => !n.isRogue);
  const rogueNodes = nodes.filter((n) => n.isRogue);
  if (rogueNodes.length > 0) {
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    connectedNodes.forEach((n) => {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    });
    if (minX === Infinity) {
      minX = w / 2;
      maxX = w / 2;
      minY = h / 2;
      maxY = h / 2;
    }

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const padding = window.isHeavyGraph() ? 300 : 150;

    let radius = Math.max((maxX - minX) / 2, (maxY - minY) / 2) + padding;
    const minCircumference = rogueNodes.length * 6;
    const minRadius = minCircumference / (2 * Math.PI);
    radius = Math.max(radius, minRadius);

    rogueNodes.forEach((n, i) => {
      const angle = (i / rogueNodes.length) * Math.PI * 2;
      n.x = centerX + Math.cos(angle) * radius;
      n.y = centerY + Math.sin(angle) * radius;
      n.fx = n.x;
      n.fy = n.y;
    });
  }

  let dummiesAdded = false;
  if (nodes.length === 1) {
    const transColor =
      typeof CONFIG !== "undefined" && CONFIG.visuals
        ? CONFIG.visuals.colors.Transparent
        : "transparent";
    nodes.push({
      ...nodes[0],
      id: "__dummy1",
      x: nodes[0].x - 150,
      y: nodes[0].y - 150,
      color: transColor,
      isRogue: true,
    });
    nodes.push({
      ...nodes[0],
      id: "__dummy2",
      x: nodes[0].x + 150,
      y: nodes[0].y + 150,
      color: transColor,
      isRogue: true,
    });
    dummiesAdded = true;
  }

  quadtree = d3
    .quadtree()
    .x((d) => d.x)
    .y((d) => d.y)
    .addAll(nodes);

  if (typeof window.setMode === "function") window.setMode("pan");
  if (typeof window.highlightCurrentView === "function")
    window.highlightCurrentView();

  setTimeout(() => {
    if (window.autoFit) window.autoFit();
    if (dummiesAdded) {
      nodes = nodes.filter((n) => !n.id.startsWith("__dummy"));
      quadtree = d3
        .quadtree()
        .x((d) => d.x)
        .y((d) => d.y)
        .addAll(nodes);
    }
  }, 100);
}

window.__APP_CORE__.startCalculation = startCalculation;
