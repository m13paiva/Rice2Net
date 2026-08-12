// ui.js
window.__APP_CORE__ = window.__APP_CORE__ || {};

window.updateActiveCounts = function () {
  let vNodes = 0;
  let vEdges = 0;
  const visibleSet = new Set();

  nodes.forEach((n) => {
    if (n.isRogue && !VISIBILITY_STATE.Rogue) return;
    if (n.color === CONFIG.visuals.colors.Transparent) return;
    vNodes++;
    visibleSet.add(n.id);
  });

  links.forEach((l) => {
    const s = l.source?.id || l.source;
    const t = l.target?.id || l.target;
    if (visibleSet.has(s) && visibleSet.has(t)) {
      if (window.isEdgeVisible ? window.isEdgeVisible(l) : true) vEdges++;
    }
  });

  const nEl = document.getElementById("val-nodes");
  const eEl = document.getElementById("val-edges");
  if (nEl) nEl.innerText = vNodes.toLocaleString();
  if (eEl) eEl.innerText = vEdges.toLocaleString();
};

function updateTargetStats(found, total) {
  const statsContainer = document.getElementById("stats");
  if (!statsContainer) return;

  let targetStat = document.getElementById("val-targets");
  if (!targetStat) {
    targetStat = document.createElement("div");
    targetStat.id = "val-targets";
    targetStat.style.marginTop = "4px";
    targetStat.style.fontSize = "0.85rem";
    targetStat.style.opacity = "0.9";
    statsContainer.appendChild(targetStat);
  }

  if (total > 0) {
    targetStat.style.display = "block";
    targetStat.innerHTML = `<span style="color:${CONFIG.visuals.colors.Green}; font-weight:bold;">${found}</span> / ${total} targets found`;
  } else {
    targetStat.style.display = "none";
  }
}

window.updateTargetCounts = function () {
  const text = document.getElementById("target-input").value;
  if (!text.trim()) {
    updateTargetStats(0, 0);
    return;
  }

  const rawTargets = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const targetSet = window.resolveTargetIds
    ? window.resolveTargetIds(rawTargets)
    : new Set(rawTargets);

  let found = 0;
  nodes.forEach((n) => {
    if (targetSet.has(n.id)) {
      if (n.color === CONFIG.visuals.colors.Transparent) return;
      if (n.isRogue && !VISIBILITY_STATE.Rogue) return;
      found++;
    }
  });

  updateTargetStats(found, rawTargets.length);
};

if (typeof window.__APP_CORE__.main === 'function') {
  window.__APP_CORE__.main();
}
