/**
 * api.js - Unified Web Data Adapter (HTTP + Static Demo Modes)
 *
 * Centralizes all network, cluster, gene metadata, regulation, and motif binding
 * data requests behind `window.RICE2NET_API`.
 *
 * Supported Web Modes:
 *  - "http" (default): Calls the Express backend using `window.API_BASE`.
 *  - "static": Serves data from static JSON bundles (`demo_data/*.json`) when
 *    `window.RICE2NET_MODE === "static"`.
 */

(function () {
  function isDemoHostOrParam() {
    try {
      if (typeof window !== "undefined" && window.RICE2NET_MODE === "static") {
        return true;
      }
      if (typeof window !== "undefined" && window.RICE2NET_MODE === "http") {
        return false;
      }
      if (typeof location !== "undefined") {
        const host = String(location.hostname || "").toLowerCase();
        if (host.endsWith("github.io")) return true;
        const params = new URLSearchParams(location.search || "");
        const demoParam = String(params.get("demo") || "").toLowerCase();
        if (demoParam === "1" || demoParam === "true") return true;
      }
    } catch (e) {}
    return false;
  }

  function getMode() {
    return isDemoHostOrParam() ? "static" : "http";
  }

  function isDemoMode() {
    return getMode() === "static";
  }

  function getApiBase() {
    if (typeof window.API_BASE !== "undefined") return window.API_BASE;
    if (typeof API_BASE !== "undefined") return API_BASE;
    return "";
  }

  function getDemoBase() {
    return (window.RICE2NET_DEMO_BASE || "demo_data").replace(/\/+$/, "");
  }

  // In-memory caches for Static Demo Mode
  const staticCache = {
    network: null,
    clusters: null,
    metadata: null,
    metadataLookup: null,
    regulation: null,
    regPairMap: null,
    bindsPairMap: null,
  };

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) {
      const err = new Error(`Request failed (${res.status}): ${url}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function normalizeLookupKey(val) {
    return String(val || "").trim().toLowerCase();
  }

  function normalizeMsuKey(val) {
    return normalizeLookupKey(val).replace(/^loc_/, "").replace(/\.\d+$/, "");
  }

  function normalizeRapKey(val) {
    return normalizeLookupKey(val).replace(/^(os\d{2})t(\d{7})(-\d+)?$/, "$1g$2");
  }

  function lookupStaticMeta(map, id) {
    if (!id) return null;
    const k = normalizeLookupKey(id);
    if (map.has(k)) return map.get(k);
    const rk = normalizeRapKey(id);
    if (rk !== k && map.has(rk)) return map.get(rk);
    const mk = normalizeMsuKey(id);
    if (mk && map.has(mk)) return map.get(mk);
    return null;
  }

  async function loadStaticMetadata() {
    if (staticCache.metadataLookup) return staticCache.metadataLookup;

    const raw = await fetchJson(`${getDemoBase()}/metadata.json`);
    const map = new Map();
    const entries = Array.isArray(raw) ? raw : Object.values(raw || {});

    entries.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      if (entry.id) map.set(normalizeLookupKey(entry.id), entry);
      if (entry.msu_id && entry.msu_id !== ".") {
        String(entry.msu_id)
          .split(/[,;\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((part) => {
            const k = normalizeLookupKey(part);
            if (k && !map.has(k)) map.set(k, entry);
            const noIso = k.replace(/\.\d+$/, "");
            if (noIso && !map.has(noIso)) map.set(noIso, entry);
            const stripped = normalizeMsuKey(part);
            if (stripped && !map.has(stripped)) map.set(stripped, entry);
          });
      }
      if (entry.identifier && entry.identifier !== ".") {
        const k = normalizeLookupKey(entry.identifier);
        if (k && !map.has(k)) map.set(k, entry);
      }
      if (entry.symbol && entry.symbol !== ".") {
        const k = normalizeLookupKey(entry.symbol);
        if (k && !map.has(k)) map.set(k, entry);
      }
    });

    // Preserve exact top-level dictionary keys too
    if (raw && !Array.isArray(raw)) {
      Object.keys(raw).forEach((key) => {
        const k = normalizeLookupKey(key);
        if (k && !map.has(k)) map.set(k, raw[key]);
      });
    }

    staticCache.metadata = raw;
    staticCache.metadataLookup = map;
    return map;
  }

  async function loadStaticRegulation() {
    if (staticCache.regPairMap && staticCache.bindsPairMap) {
      return {
        regPairMap: staticCache.regPairMap,
        bindsPairMap: staticCache.bindsPairMap,
      };
    }

    let raw = {};
    try {
      raw = await fetchJson(`${getDemoBase()}/regulation.json`);
    } catch (err) {
      if (err.status !== 404) throw err;
    }

    const regPairMap = new Map();
    const bindsPairMap = new Map();

    const addDirection = (src, tgt) => {
      const a = String(src);
      const b = String(tgt);
      const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!regPairMap.has(pairKey)) regPairMap.set(pairKey, []);
      const list = regPairMap.get(pairKey);
      if (!list.some((d) => d.src === a && d.tgt === b)) {
        list.push({ src: a, tgt: b });
      }
    };

    if (raw && Array.isArray(raw.edges)) {
      raw.edges.forEach((e) => {
        if (Array.isArray(e.directions)) {
          e.directions.forEach((d) => {
            if (d && d.src && d.tgt) addDirection(d.src, d.tgt);
          });
        } else if (e.src && e.tgt) {
          addDirection(e.src, e.tgt);
        }
      });
    } else if (raw && raw.directions && typeof raw.directions === "object") {
      Object.values(raw.directions).forEach((dirs) => {
        if (Array.isArray(dirs)) {
          dirs.forEach((d) => {
            if (d && d.src && d.tgt) addDirection(d.src, d.tgt);
          });
        }
      });
    }

    const bindsObj = raw && (raw.bindsByPair || raw.binds);
    if (bindsObj && typeof bindsObj === "object") {
      Object.entries(bindsObj).forEach(([key, binds]) => {
        if (Array.isArray(binds)) {
          bindsPairMap.set(key, binds);
          const parts = key.split("->");
          if (parts.length === 2 && binds.length > 0) {
            addDirection(parts[0], parts[1]);
          }
        }
      });
    }

    staticCache.regulation = raw;
    staticCache.regPairMap = regPairMap;
    staticCache.bindsPairMap = bindsPairMap;
    return { regPairMap, bindsPairMap };
  }

  /**
   * 1. Fetch initial network topology (nodes + edges)
   */
  async function initNetwork() {
    if (getMode() === "static") {
      if (!staticCache.network) {
        staticCache.network = await fetchJson(`${getDemoBase()}/network.json`);
      }
      return staticCache.network;
    }
    return fetchJson(`${getApiBase()}/api/network/init`);
  }

  /**
   * 2. Fetch functional cluster definitions
   */
  async function getClusters() {
    if (getMode() === "static") {
      if (!staticCache.clusters) {
        try {
          staticCache.clusters = await fetchJson(`${getDemoBase()}/clusters.json`);
        } catch (err) {
          if (err.status === 404) staticCache.clusters = { clusters: [] };
          else throw err;
        }
      }
      return staticCache.clusters;
    }
    return fetchJson(`${getApiBase()}/api/network/clusters`);
  }

  /**
   * 3. Fetch full metadata for a single gene node
   */
  async function getNodeMetadata(id) {
    if (!id) return null;
    if (getMode() === "static") {
      const lookup = await loadStaticMetadata();
      return lookupStaticMeta(lookup, id);
    }

    const res = await fetch(
      `${getApiBase()}/api/network/node/${encodeURIComponent(id)}`
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const err = new Error(`Failed to fetch node metadata (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /**
   * 4. Fetch full metadata for a batch of gene IDs
   */
  async function getNodesMetadataBatch(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return { nodesById: {} };
    }

    if (getMode() === "static") {
      const lookup = await loadStaticMetadata();
      const nodesById = {};
      ids.forEach((id) => {
        const entry = lookupStaticMeta(lookup, id);
        if (entry) nodesById[String(id)] = entry;
      });
      return { nodesById };
    }

    const res = await fetch(`${getApiBase()}/api/network/nodes/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });

    if (res.ok) {
      return res.json();
    }

    // Fallback for older backend instances without /api/network/nodes/batch
    if (res.status === 404 || res.status === 405) {
      const nodesById = {};
      const concurrency = 25;
      for (let i = 0; i < ids.length; i += concurrency) {
        const chunk = ids.slice(i, i + concurrency);
        await Promise.all(
          chunk.map(async (id) => {
            try {
              const data = await getNodeMetadata(id);
              if (data) nodesById[String(id)] = data;
            } catch (e) {
              console.warn(`Fallback metadata fetch failed for ${id}`);
            }
          })
        );
      }
      return { nodesById };
    }

    const err = new Error(`Batch node metadata request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }

  /**
   * 5. Query regulatory directions for a batch of undirected gene pairs
   */
  async function checkRegulates(pairs) {
    if (!Array.isArray(pairs) || pairs.length === 0) {
      return { edges: [] };
    }

    if (getMode() === "static") {
      const { regPairMap } = await loadStaticRegulation();
      const edges = [];
      pairs.forEach((p) => {
        if (!p || !p.s || !p.t) return;
        const a = String(p.s);
        const b = String(p.t);
        const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;
        const directions = regPairMap.get(pairKey);
        if (directions && directions.length > 0) {
          edges.push({
            original_s: a,
            original_t: b,
            directions,
            has_regulates: true,
          });
        }
      });
      return { edges };
    }

    return fetchJson(`${getApiBase()}/api/network/edges/regulates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairs }),
    });
  }

  /**
   * 6. Fetch TF-promoter motif binding events for a single directed edge
   */
  async function getBinds(source, target) {
    if (!source || !target) return { binds: [] };

    if (getMode() === "static") {
      const { bindsPairMap } = await loadStaticRegulation();
      const key = `${String(source)}->${String(target)}`;
      return { binds: bindsPairMap.get(key) || [] };
    }

    return fetchJson(
      `${getApiBase()}/api/network/edges/binds?source=${encodeURIComponent(
        source
      )}&target=${encodeURIComponent(target)}`
    );
  }

  /**
   * 7. Fetch TF-promoter motif binding events for a batch of directed edges
   */
  async function getBindsBatch(pairs) {
    if (!Array.isArray(pairs) || pairs.length === 0) {
      return { bindsByPair: {} };
    }

    if (getMode() === "static") {
      const { bindsPairMap } = await loadStaticRegulation();
      const bindsByPair = {};
      pairs.forEach((p) => {
        const src = String(p.source || p.s || "");
        const tgt = String(p.target || p.t || "");
        if (!src || !tgt) return;
        const key = `${src}->${tgt}`;
        if (bindsPairMap.has(key)) {
          bindsByPair[key] = bindsPairMap.get(key);
        }
      });
      return { bindsByPair };
    }

    const res = await fetch(`${getApiBase()}/api/network/edges/binds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairs }),
    });

    if (res.ok) {
      return res.json();
    }

    // Fallback to individual GET calls if batch endpoint unavailable
    if (res.status === 404 || res.status === 405) {
      const bindsByPair = {};
      await Promise.all(
        pairs.map(async (p) => {
          const src = String(p.source || p.s || "");
          const tgt = String(p.target || p.t || "");
          if (!src || !tgt) return;
          try {
            const data = await getBinds(src, tgt);
            bindsByPair[`${src}->${tgt}`] = data.binds || [];
          } catch (e) {
            console.warn(`Fallback binds fetch failed for ${src}->${tgt}`);
          }
        })
      );
      return { bindsByPair };
    }

    const err = new Error(`Batch binds request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }

  window.RICE2NET_API = {
    get isDemo() {
      return isDemoMode();
    },
    getMode,
    isDemoMode,
    initNetwork,
    getClusters,
    getNodeMetadata,
    getNodesMetadataBatch,
    checkRegulates,
    getBinds,
    getBindsBatch,
  };
})();
