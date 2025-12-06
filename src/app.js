// Vanilla JS renderer for friends JSON -> vis-network graph
// Expects JSON of shape: { [id]: { name: string, mutual: string[] } }

(function () {
  const fileInput = document.getElementById('fileInput');
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  const statsEl = document.getElementById('stats');
  const container = document.getElementById('network');
  const overlay = document.getElementById('loadingOverlay');
  const loaderMsgEl = document.getElementById('loaderMessage');
  const loaderBarEl = document.getElementById('loaderBar');

  /** @type {vis.Network | null} */
  let network = null;
  /** @type {number | null} */
  let stabilizeTimeoutId = null;
  /** @type {vis.DataSet | null} */
  let nodesDS = null;
  /** @type {vis.DataSet | null} */
  let edgesDS = null;
  /** Cached lowercase username map for search */
  let idByLowerName = new Map();
  /** Base colors per node id so we can restore after highlights */
  const baseColorById = new Map();

  function reset() {
    idByLowerName.clear();
    baseColorById.clear();
    if (stabilizeTimeoutId !== null) {
      clearTimeout(stabilizeTimeoutId);
      stabilizeTimeoutId = null;
    }
    if (network) {
      network.destroy();
    }
    container.innerHTML = '';
    nodesDS = null;
    edgesDS = null;
    network = null;
    searchInput.value = '';
  }

  function setStats(msg) {
    statsEl.textContent = msg;
  }

  function showOverlay(message, pct) {
    if (message) loaderMsgEl.textContent = message;
    if (typeof pct === 'number') loaderBarEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
    overlay.hidden = false;
  }

  function hideOverlay() {
    overlay.hidden = true;
  }

  function parseJSONText(text) {
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Root must be an object keyed by user id.');
      }
      return data;
    } catch (e) {
      alert('Invalid JSON: ' + e.message);
      throw e;
    }
  }

  // Remove trailing "#0" sequences from usernames (e.g., "alice#0" -> "alice",
  // "bob#0#0" -> "bob"). Keeps the rest untouched.
  function cleanUsername(name) {
    if (typeof name !== 'string') return String(name ?? '');
    return name.replace(/(?:#0)+$/i, '').trim();
  }

  // Build nodes and edges arrays from input data
  async function buildGraphAsync(dataObj, onProgress) {
    const nodes = [];
    const edges = [];
    const have = new Set(Object.keys(dataObj));
    // Track degree (unique mutuals within dataset) to scale node size
    const degree = new Map();

    // Phase 1: nodes
    const entries = Object.entries(dataObj);
    const totalNodes = entries.length;
    const nodeChunk = 500;
    for (let i = 0; i < totalNodes; i++) {
      const [id, info] = entries[i];
      const label = info && info.name ? cleanUsername(info.name) : id;
      const { background, border } = colorFromId(id);
      const color = { background, border };
      baseColorById.set(id, color);
      nodes.push({ id, label, title: label, color, value: 0 });
      degree.set(id, 0);
      idByLowerName.set(label.toLowerCase(), id);
      if (i % nodeChunk === 0) {
        onProgress && onProgress({ phase: 'nodes', done: i + 1, total: totalNodes });
        await new Promise(r => setTimeout(r)); // yield
      }
    }
    onProgress && onProgress({ phase: 'nodes', done: totalNodes, total: totalNodes });

    // Phase 2: edges (undirected, deduped)
    const seen = new Set();
    const keys = Object.keys(dataObj);
    let processed = 0;
    let totalPairs = 0;
    for (const k of keys) {
      const info = dataObj[k];
      if (info && Array.isArray(info.mutual)) totalPairs += info.mutual.length;
    }
    const edgeChunk = 4000;
    for (const [a, info] of entries) {
      if (!info || !Array.isArray(info.mutual)) continue;
      for (const b of info.mutual) {
        processed++;
        if (!have.has(b)) continue;
        const [x, y] = a < b ? [a, b] : [b, a];
        const key = x + '|' + y;
        if (x === y || seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: x, to: y });
        // Increment degree for both endpoints
        degree.set(x, (degree.get(x) || 0) + 1);
        degree.set(y, (degree.get(y) || 0) + 1);
        if (processed % edgeChunk === 0) {
          onProgress && onProgress({ phase: 'edges', done: processed, total: totalPairs });
          await new Promise(r => setTimeout(r));
        }
      }
    }
    onProgress && onProgress({ phase: 'edges', done: totalPairs, total: totalPairs });

    // Apply degree counts to nodes for sizing and enrich title
    for (const n of nodes) {
      const d = degree.get(n.id) || 0;
      n.value = d;
      n.title = `${n.title}\nMutuals: ${d}`;
    }

    return { nodes, edges };
  }

  // Deterministic color generation per id
  function colorFromId(id) {
    const h = (hashString(id) % 360 + 360) % 360; // 0..359
    const s = 65; // saturation
    const l = 50; // lightness
    const background = hslToHex(h, s, l);
    const border = hslToHex(h, s, Math.max(0, l - 18));
    return { background, border };
  }

  function hashString(str) {
    // Simple fast hash (xorshift-like), deterministic
    let h1 = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < str.length; i++) {
      h1 ^= str.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193); // FNV prime
    }
    // Mix a bit more
    h1 ^= h1 >>> 16;
    h1 = Math.imul(h1, 0x85ebca6b);
    h1 ^= h1 >>> 13;
    h1 = Math.imul(h1, 0xc2b2ae35);
    h1 ^= h1 >>> 16;
    return Math.abs(h1);
  }

  function hslToHex(h, s, l) {
    // h [0,360), s/l [0,100]
    s /= 100;
    l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (0 <= h && h < 60) { r = c; g = x; b = 0; }
    else if (60 <= h && h < 120) { r = x; g = c; b = 0; }
    else if (120 <= h && h < 180) { r = 0; g = c; b = x; }
    else if (180 <= h && h < 240) { r = 0; g = x; b = c; }
    else if (240 <= h && h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    const toHex = v => {
      const n = Math.round((v + m) * 255);
      return n.toString(16).padStart(2, '0');
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function initNetwork(nodes, edges) {
    nodesDS = new vis.DataSet(nodes);
    edgesDS = new vis.DataSet(edges);

    const data = { nodes: nodesDS, edges: edgesDS };
    const options = {
      autoResize: true,
      interaction: {
        hover: true,
        hideEdgesOnDrag: true,
        hideEdgesOnZoom: false,
        tooltipDelay: 100,
        zoomSpeed: 0.5
      },
      physics: {
        enabled: true,
        solver: 'forceAtlas2Based',
        stabilization: { enabled: true, iterations: 500, updateInterval: 25 },
        barnesHut: { avoidOverlap: 0.1 },
        forceAtlas2Based: { gravitationalConstant: -50, springLength: 100, damping: 0.6 }
      },
      nodes: {
        shape: 'dot',
        size: 8,
        scaling: { min: 6, max: 28 },
        font: { size: 12, color: '#e8e8e8' },
        color: { background: '#4e79a7', border: '#2e4a67' }
      },
      edges: {
        color: { color: '#7f8fa6', highlight: '#f6c177' },
        width: 1,
        selectionWidth: 1.5,
        smooth: false
      },
      layout: { improvedLayout: false }
    };

    network = new vis.Network(container, data, options);

    // Physics progress indicator
    let lastPct = 0;
    network.on('stabilizationProgress', function (params) {
      const pct = Math.round((params.iterations / params.total) * 100);
      if (pct !== lastPct) {
        showOverlay(`Stabilizing layout… ${pct}%`, pct);
        lastPct = pct;
      }
    });

    // When iterations complete, stop physics to prevent continuous motion
    network.once('stabilizationIterationsDone', function () {
      // Clear fallback stopper if pending
      if (stabilizeTimeoutId !== null) {
        clearTimeout(stabilizeTimeoutId);
        stabilizeTimeoutId = null;
      }
      network.stopSimulation();
      network.setOptions({ physics: { enabled: false } });
      hideOverlay();
      setStats(`Nodes: ${nodes.length.toLocaleString()} | Edges: ${edges.length.toLocaleString()}`);
    });

    // Fallback: if stabilization keeps running too long, force stop and freeze layout
    // Timeout scaled lightly by node count but capped between 6s and 15s
    const approxMs = Math.min(15000, Math.max(6000, nodes.length * 5));
    stabilizeTimeoutId = setTimeout(() => {
      // If still stabilizing, stop and disable physics
      if (network) {
        network.stopSimulation();
        network.setOptions({ physics: { enabled: false } });
      }
      hideOverlay();
      setStats(`Nodes: ${nodes.length.toLocaleString()} | Edges: ${edges.length.toLocaleString()}`);
      stabilizeTimeoutId = null;
    }, approxMs);
  }

  async function loadFromFile(file) {
    reset();
    setStats('Loading...');
    showOverlay('Reading file…', 5);
    const text = await file.text();
    showOverlay('Parsing JSON…', 12);
    const obj = parseJSONText(text);

    showOverlay('Building nodes…', 15);
    const { nodes, edges } = await buildGraphAsync(obj, ({ phase, done, total }) => {
      const base = phase === 'nodes' ? 15 : 55; // start percentages for phases
      const span = phase === 'nodes' ? 40 : 40; // each phase span
      const pct = total > 0 ? base + Math.min(1, done / total) * span : base;
      const msg = phase === 'nodes'
        ? `Building nodes… ${Math.min(100, Math.round((done / Math.max(1,total)) * 100))}%`
        : `Linking edges… ${Math.min(100, Math.round((done / Math.max(1,total)) * 100))}%`;
      showOverlay(msg, Math.round(pct));
    });

    // Initialize network; stabilization progress will take over the overlay
    initNetwork(nodes, edges);
    searchInput.disabled = false;
    clearSearchBtn.disabled = false;
  }

  function highlightByUsernamePart(query) {
    if (!network || !nodesDS) return;
    const q = query.trim().toLowerCase();
    const allNodes = nodesDS.get();

    // Reset colors
    const dimColor = '#394b5a';
    const highlightNodeColor = { background: '#f6c177', border: '#845a2c' };

    const updates = [];
    for (const n of allNodes) {
      const base = baseColorById.get(n.id) || n.color || { background: '#4e79a7', border: '#2e4a67' };
      updates.push({ id: n.id, color: base, opacity: 1 });
    }
    nodesDS.update(updates);

    if (!q) return;

    // Find nodes whose label includes query
    const matchedIds = new Set();
    for (const n of allNodes) {
      if (String(n.label).toLowerCase().includes(q)) {
        matchedIds.add(n.id);
      }
    }

    if (matchedIds.size === 0) return;

    // Get neighbors of all matched
    const neighborIds = new Set();
    for (const id of matchedIds) {
      const neigh = network.getConnectedNodes(id);
      for (const m of neigh) neighborIds.add(String(m));
    }

    // Dim all, then highlight matched + neighbors
    const dimUpdates = [];
    for (const n of allNodes) {
      if (!matchedIds.has(n.id) && !neighborIds.has(n.id)) {
        const base = baseColorById.get(n.id) || n.color || { border: '#2e4a67' };
        dimUpdates.push({ id: n.id, color: { background: dimColor, border: base.border }, opacity: 0.4 });
      }
    }
    nodesDS.update(dimUpdates);

    const hiUpdates = [];
    for (const id of matchedIds) {
      hiUpdates.push({ id, color: highlightNodeColor, opacity: 1 });
    }
    for (const id of neighborIds) {
      if (!matchedIds.has(id)) hiUpdates.push({ id, color: { background: '#9cb9d9', border: '#2e4a67' }, opacity: 0.9 });
    }
    nodesDS.update(hiUpdates);

    // Focus to the first match
    const first = matchedIds.values().next().value;
    if (first) network.focus(first, { scale: 1, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
  }

  // Events
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    loadFromFile(file);
  });

  searchInput.addEventListener('input', (e) => {
    const value = e.target.value || '';
    // debounce via rAF
    if (searchInput._raf) cancelAnimationFrame(searchInput._raf);
    searchInput._raf = requestAnimationFrame(() => highlightByUsernamePart(value));
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    highlightByUsernamePart('');
  });
})();
