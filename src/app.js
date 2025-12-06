// Vanilla JS renderer for friends JSON -> vis-network graph
// Expects JSON of shape: { [id]: { name: string, mutual: string[] } }

(function () {
    const fileInput = document.getElementById('fileInput');
    const avatarToggle = document.getElementById('avatarToggle');
    const hideNamesToggle = document.getElementById('hideNamesToggle');
    const hideRootLeavesToggle = document.getElementById('hideRootLeaves');
    // The label wrapper of the root-leaf toggle, used to show/hide the control
    const hideRootLeavesLabel = hideRootLeavesToggle ? hideRootLeavesToggle.closest('label') : null;
    const searchInput = document.getElementById('searchInput');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    const statsEl = document.getElementById('stats');
    const container = document.getElementById('network');
    const sidebar = document.getElementById('sidebar');
    const sidebarTitle = document.getElementById('sidebarTitle');
    const sidebarContent = document.getElementById('sidebarContent');
    const sidebarClose = document.getElementById('sidebarClose');
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
    /** Loaded sources: { name: fileName, data: object } */
    let sources = [];
    /** Merged source data built from all sources */
    let mergedData = null;
    /** Currently selected node id */
    let selectedId = null;
    /** Avatar mode flag */
    let useAvatars = false;
    /** Hide usernames flag */
    let hideNames = false;
    /** Cache of generated avatar data URLs by node id */
    const avatarUrlById = new Map();
    /** Roots detected from sources (origin IDs created/ensured per source) */
    let rootIds = new Set();
    /** Hide leaves connected only to a root flag */
    let hideLeaves = false;

    // Show or hide the "Hide nodes with only one connection to a root" control based on context
    function setRootLeafControlVisibility(show) {
        if (!hideRootLeavesLabel || !hideRootLeavesToggle) return;
        if (show) {
            hideRootLeavesLabel.hidden = false;
        } else {
            // When hiding the control, also clear its state and disable filtering
            hideRootLeavesLabel.hidden = true;
            if (hideRootLeavesToggle.checked) hideRootLeavesToggle.checked = false;
            hideLeaves = false;
        }
    }

    // Initial state before any data is loaded: hidden (since there's no source yet)
    setRootLeafControlVisibility(false);

    // Control which edges are shown for clarity during highlighting/selection.
    // If visibleNodeIds is null, show all edges. Otherwise, only show edges whose
    // both endpoints are within the visibleNodeIds set.
    function updateEdgesVisibility(visibleNodeIds) {
        if (!edgesDS) return;
        const allEdges = edgesDS.get();
        // Fast path: show all
        if (!visibleNodeIds) {
            const updates = [];
            for (const e of allEdges) {
                if (e.hidden) {
                    updates.push({id: e.id, hidden: false});
                }
            }
            if (updates.length) {
                edgesDS.update(updates);
            }
            return;
        }
        const updates = [];
        for (const e of allEdges) {
            const fromVisible = visibleNodeIds.has(String(e.from));
            const toVisible = visibleNodeIds.has(String(e.to));
            const shouldShow = fromVisible && toVisible;
            if (!!e.hidden === shouldShow) {
                // toggle only when state differs; e.hidden is true means currently hidden
                updates.push({id: e.id, hidden: !shouldShow});
            }
        }
        if (updates.length) edgesDS.update(updates);
    }

    function reset() {
        idByLowerName.clear();
        baseColorById.clear();
        sources = [];
        mergedData = null;
        selectedId = null;
        useAvatars = avatarToggle?.checked || false;
        hideNames = hideNamesToggle?.checked || false;
        // By default (no sources yet), the root-leaf filter control should be hidden
        setRootLeafControlVisibility(false);
        hideLeaves = hideRootLeavesToggle?.checked || false;
        avatarUrlById.clear();
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
        hideSidebar();
    }

    function setStats(msg) {
        statsEl.textContent = msg;
    }

    function showOverlay(message, pct) {
        if (message) loaderMsgEl.textContent = message;
        if (typeof pct === 'number') {
            loaderBarEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
        }
        overlay.hidden = false;
    }

    function hideOverlay() {
        overlay.hidden = true;
    }

    function hideSidebar() {
        if (sidebar) sidebar.hidden = true;
    }

    function showSidebar() {
        if (sidebar) sidebar.hidden = false;
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
        if (typeof name !== 'string') {
            return String(name ?? '');
        }
        return name.replace(/(?:#0)+$/i, '').trim();
    }

    // Extract discriminator (0001..9999) from a name like "foo#1234"
    function discriminatorFromName(name) {
        if (typeof name !== 'string') {
            return null;
        }
        const m = name.match(/#(\d{1,4})$/);
        return m ? parseInt(m[1], 10) : null;
    }

    // Build a Discord CDN avatar URL if we have either a full URL or a hash.
    function resolveAvatarUrl(id, info) {
        if (!info) {
            return null;
        }
        const raw = info.avatarUrl || info.avatar || null;
        if (typeof raw === 'string' && raw.length > 0) {
            if (/^https?:\/\//i.test(raw)) {
                return raw;
            } // already a URL
            // assume it's an avatar hash from Discord
            return `https://cdn.discordapp.com/avatars/${id}/${raw}.png?size=128`;
        }
        // Fallback to default embed avatar using discriminator (0..4)
        const disc = discriminatorFromName(info.name || '')
            ?? (typeof id === 'string' ? (parseInt(id.slice(-2), 10) || 0) : 0);
        const idx = Math.abs(disc) % 5;
        return `https://cdn.discordapp.com/embed/avatars/${idx}.png?size=128`;
    }

    // Merge multiple source objects into a combined object: { id: { name, mutual: string[] } }
    function mergeSources(objs) {
        const out = {};
        for (const obj of objs) {
            if (!obj || typeof obj !== 'object') continue;
            for (const [id, info] of Object.entries(obj)) {
                if (!out[id]) {
                    const label = info && info.name ? cleanUsername(info.name) : id;
                    // carry an avatarUrl if available (or build discord default)
                    const avatarUrl = resolveAvatarUrl(id, info);
                    out[id] = {name: label, mutual: [], avatarUrl};
                } else {
                    // If existing name is just the id (placeholder), and this source has a proper name, upgrade it.
                    const incomingName = info && info.name ? cleanUsername(info.name) : '';
                    if (incomingName && (out[id].name === id || !out[id].name)) {
                        out[id].name = incomingName;
                    }
                    // Prefer avatar from the first source that has a non-empty url/hash
                    if (!out[id].avatarUrl) {
                        const avatarUrl = resolveAvatarUrl(id, info);
                        out[id].avatarUrl = avatarUrl || out[id].avatarUrl;
                    }
                }
            }
        }
        // Union mutuals across sources per id
        const tmpSet = new Map(); // id -> Set
        for (const id of Object.keys(out)) {
            tmpSet.set(id, new Set());
        }

        for (const obj of objs) {
            for (const [a, info] of Object.entries(obj)) {
                if (!out[a]) continue;
                if (!info || !Array.isArray(info.mutual)) continue;
                const setA = tmpSet.get(a);
                for (const b of info.mutual) setA && setA.add(String(b));
            }
        }
        for (const [id, set] of tmpSet.entries()) {
            out[id].mutual = Array.from(set);
        }
        return out;
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
            const {background, border} = colorFromId(id);
            const color = {background, border};
            baseColorById.set(id, color);
            // store avatar URL (real CDN or default) for avatar mode
            const avatarUrl = info && info.avatarUrl ? info.avatarUrl : resolveAvatarUrl(id, info);
            if (avatarUrl) avatarUrlById.set(id, avatarUrl);
            nodes.push({id, label, title: label, color, value: 0});
            degree.set(id, 0);
            idByLowerName.set(label.toLowerCase(), id);
            if (i % nodeChunk === 0) {
                onProgress && onProgress({phase: 'nodes', done: i + 1, total: totalNodes});
                await new Promise(r => setTimeout(r)); // yield
            }
        }
        onProgress && onProgress({phase: 'nodes', done: totalNodes, total: totalNodes});

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
                edges.push({from: x, to: y});
                // Increment degree for both endpoints
                degree.set(x, (degree.get(x) || 0) + 1);
                degree.set(y, (degree.get(y) || 0) + 1);
                if (processed % edgeChunk === 0) {
                    onProgress && onProgress({phase: 'edges', done: processed, total: totalPairs});
                    await new Promise(r => setTimeout(r));
                }
            }
        }
        onProgress && onProgress({phase: 'edges', done: totalPairs, total: totalPairs});

        // Apply degree counts to nodes for sizing and enrich title
        for (const n of nodes) {
            const d = degree.get(n.id) || 0;
            n.value = d;
            n.title = `${n.title}\nMutuals: ${d}`;
        }

        return {nodes, edges};
    }

    // Filter nodes that have exactly one connection and that sole neighbor is a root node
    function filterLeavesConnectedToRoots(nodes, edges) {
        if (!hideLeaves || !rootIds || rootIds.size === 0) return {nodes, edges};
        const adj = new Map(); // id -> Set(neighbors)
        for (const n of nodes) adj.set(String(n.id), new Set());
        for (const e of edges) {
            const a = String(e.from);
            const b = String(e.to);
            if (!adj.has(a)) adj.set(a, new Set());
            if (!adj.has(b)) adj.set(b, new Set());
            adj.get(a).add(b);
            adj.get(b).add(a);
        }
        const toRemove = new Set();
        for (const [id, neigh] of adj.entries()) {
            if (neigh.size === 1) {
                const only = neigh.values().next().value;
                if (rootIds.has(String(only)) && !rootIds.has(String(id))) {
                    toRemove.add(String(id));
                }
            }
        }
        if (toRemove.size === 0) return {nodes, edges};
        const keptNodes = nodes.filter(n => !toRemove.has(String(n.id)));
        const keptNodeSet = new Set(keptNodes.map(n => String(n.id)));
        const keptEdges = edges.filter(e => keptNodeSet.has(String(e.from)) && keptNodeSet.has(String(e.to)));
        return {nodes: keptNodes, edges: keptEdges};
    }

    // Deterministic color generation per id
    function colorFromId(id) {
        const h = (hashString(id) % 360 + 360) % 360; // 0..359
        const s = 65; // saturation
        const l = 50; // lightness
        const background = hslToHex(h, s, l);
        const border = hslToHex(h, s, Math.max(0, l - 18));
        return {background, border};
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
        if (0 <= h && h < 60) {
            r = c;
            g = x;
            b = 0;
        } else if (60 <= h && h < 120) {
            r = x;
            g = c;
            b = 0;
        } else if (120 <= h && h < 180) {
            r = 0;
            g = c;
            b = x;
        } else if (180 <= h && h < 240) {
            r = 0;
            g = x;
            b = c;
        } else if (240 <= h && h < 300) {
            r = x;
            g = 0;
            b = c;
        } else {
            r = c;
            g = 0;
            b = x;
        }
        const toHex = v => {
            const n = Math.round((v + m) * 255);
            return n.toString(16).padStart(2, '0');
        };
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }

    function initNetwork(nodes, edges) {
        nodesDS = new vis.DataSet(nodes);
        edgesDS = new vis.DataSet(edges);

        const data = {nodes: nodesDS, edges: edgesDS};
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
                stabilization: {enabled: true, iterations: 500, updateInterval: 25},
                barnesHut: {avoidOverlap: 0.1},
                forceAtlas2Based: {gravitationalConstant: -50, springLength: 100, damping: 0.6}
            },
            nodes: {
                shape: 'dot',
                size: 8,
                scaling: {min: 6, max: 28},
                font: {size: 12, color: '#e8e8e8'},
                color: {background: '#4e79a7', border: '#2e4a67'}
            },
            edges: {
                color: {color: '#474c54', highlight: '#f6c177'},
                width: 1,
                selectionWidth: 1.5,
                smooth: false
            },
            layout: {improvedLayout: false}
        };

        network = new vis.Network(container, data, options);

        // If avatars toggle is on, apply avatar mode now
        applyAvatarMode(useAvatars);

        // Apply hide usernames after network init if enabled
        applyHideUsernames(hideNames);

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
            network.setOptions({physics: {enabled: false}});
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
                network.setOptions({physics: {enabled: false}});
            }
            hideOverlay();
            setStats(`Nodes: ${nodes.length.toLocaleString()} | Edges: ${edges.length.toLocaleString()}`);
            stabilizeTimeoutId = null;
        }, approxMs);

        // Click selection handler
        network.on('click', (params) => {
            if (params.nodes && params.nodes.length === 1) {
                const id = String(params.nodes[0]);
                setSelected(id, {focus: true, openSidebar: true});
            } else {
                clearSelection();
            }
        });
    }

    function applyHideUsernames(enabled) {
        if (!network) return;
        // Toggle the global node font size to hide/show labels without touching data
        const size = enabled ? 0 : 12;
        network.setOptions({nodes: {font: {size}}});
        hideNames = !!enabled;
    }

    function initialsFromLabel(label) {
        const s = String(label || '').trim();
        if (!s) return '?';
        // Split by non-alphanumeric or camelcase boundaries
        const parts = s
            .replace(/[_\-]+/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .split(/\s+/)
            .filter(Boolean);
        let letters = '';
        for (let i = 0; i < parts.length && letters.length < 2; i++) {
            letters += parts[i][0] || '';
        }
        if (!letters) letters = s[0];
        return letters.slice(0, 2).toUpperCase();
    }

    function makeAvatarDataUrl(id, label) {
        const base = baseColorById.get(id) || {background: '#4e79a7', border: '#2e4a67'};
        const bg = base.background;
        const text = initialsFromLabel(label);
        const size = 128;
        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><clipPath id="c"><circle cx="64" cy="64" r="64"/></clipPath></defs>
  <g clip-path="url(#c)">
    <rect width="${size}" height="${size}" fill="${bg}"/>
  </g>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="Inter,Segoe UI,system-ui,Arial" font-weight="700" font-size="56" fill="#ffffff">${text}</text>
</svg>`;
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    }

    function ensureAvatarUrl(id, label) {
        // Prefer a real image URL if one was captured; fall back to generated SVG initials
        const fallback = makeAvatarDataUrl(id, label);
        const current = avatarUrlById.get(id);
        if (current) return {image: current, brokenImage: fallback};
        avatarUrlById.set(id, fallback);
        return {image: fallback, brokenImage: fallback};
    }

    function applyAvatarMode(enabled) {
        if (!nodesDS) return;
        useAvatars = !!enabled;
        const all = nodesDS.get();
        const updates = [];
        if (useAvatars) {
            for (const n of all) {
                const {image, brokenImage} = ensureAvatarUrl(n.id, n.label);
                const base = baseColorById.get(n.id) || n.color || {border: '#2e4a67'};
                updates.push({
                    id: n.id,
                    shape: 'circularImage',
                    image,
                    brokenImage,
                    borderWidth: 2,
                    color: {border: base.border}
                });
            }
        } else {
            for (const n of all) {
                const base = baseColorById.get(n.id) || n.color || {background: '#4e79a7', border: '#2e4a67'};
                updates.push({
                    id: n.id,
                    shape: 'dot',
                    image: undefined,
                    brokenImage: undefined,
                    color: base,
                    borderWidth: 1
                });
            }
        }
        nodesDS.update(updates);

        // Re-apply current selection/search state visuals
        if (selectedId) {
            setSelected(selectedId, {focus: false, openSidebar: false});
        } else if (searchInput.value.trim()) {
            highlightByUsernamePart(searchInput.value);
        }
    }

    function baseFileName(name) {
        return String(name || '').replace(/\.[^.]+$/, '');
    }

    async function loadFromFiles(fileList) {
        reset();
        setStats('Loading...');
        const files = Array.from(fileList || []);
        if (files.length === 0) {
            return;
        }
        const allFriendObjs = [];

        // Read + parse each file sequentially to keep progress clear
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            showOverlay(`Reading ${f.name}… (${i + 1}/${files.length})`, Math.round((i / files.length) * 12 + 2));
            const text = await f.text();
            showOverlay(`Parsing ${f.name}…`, Math.round((i / files.length) * 12 + 8));
            const obj = parseJSONText(text);
            allFriendObjs.push(obj);
        }

        // Rule: Only add/ensure an origin's connections if the file name (without .json)
        // matches the ID of a node in that file. Otherwise, do nothing special.
        const isMultiSource = files.length > 1;
        // Only show the root-leaf filter when there are multiple sources
        setRootLeafControlVisibility(isMultiSource);
        // Per requirement: when loading multiple sources, default-enable the
        // "Hide nodes with only one connection to a root" filter so that it
        // is applied on the initial render. When single-source, ensure it's off.
        if (isMultiSource) {
            if (hideRootLeavesToggle) hideRootLeavesToggle.checked = true;
            hideLeaves = true;
        } else {
            if (hideRootLeavesToggle) hideRootLeavesToggle.checked = false;
            hideLeaves = false;
        }
        const detectedRoots = new Set();
        const augmented = allFriendObjs.map((obj, idx) => {
            try {
                if (!obj || typeof obj !== 'object') {
                    return obj;
                }

                const base = baseFileName(files[idx].name);
                if (!base || !isMultiSource) {
                    return obj;
                }

                // helper to detect Discord snowflake-like ids (all digits, typical 17-20; allow 15-22)
                const looksLikeId = /^\d{15,22}$/.test(base);
                const allIds = Object.keys(obj);

                // Case 1: base name matches an existing node id → ensure it's connected to all others
                if (base in obj) {
                    const clone = {...obj};
                    const originId = base;
                    detectedRoots.add(String(originId));
                    const originInfo = {...clone[originId]};
                    const current = new Set(Array.isArray(originInfo.mutual) ? originInfo.mutual.map(String) : []);
                    for (const id of allIds) {
                        if (id !== originId) {
                            current.add(String(id));
                        }
                    }
                    originInfo.mutual = Array.from(current);
                    clone[originId] = originInfo;
                    return clone;
                }

                // Case 2: base name looks like an ID but node is missing → create a synthetic origin node
                if (looksLikeId && allIds.length) {
                    const clone = {...obj};
                    const originId = base;
                    detectedRoots.add(String(originId));
                    const mutual = allIds.filter(id => id !== originId).map(String);
                    clone[originId] = {
                        name: originId,
                        mutual,
                        avatarUrl: ''
                    };
                    return clone;
                }

                // Otherwise: leave unchanged
                return obj;
            } catch {
                return obj;
            }
        });

        sources = files.map((f, idx) => ({name: f.name, data: augmented[idx]}));
        mergedData = mergeSources(augmented);
        rootIds = detectedRoots; // save detected roots for filtering

        showOverlay('Building nodes…', 15);
        const {nodes, edges} = await buildGraphAsync(mergedData, ({phase, done, total}) => {
            const base = phase === 'nodes' ? 15 : 55; // start percentages for phases
            const span = phase === 'nodes' ? 40 : 40; // each phase span
            const pct = total > 0 ? base + Math.min(1, done / total) * span : base;
            const msg = phase === 'nodes'
                ? `Building nodes… ${Math.min(100, Math.round((done / Math.max(1, total)) * 100))}%`
                : `Linking edges… ${Math.min(100, Math.round((done / Math.max(1, total)) * 100))}%`;
            showOverlay(msg, Math.round(pct));
        });

        const filtered = filterLeavesConnectedToRoots(nodes, edges);
        initNetwork(filtered.nodes, filtered.edges);
        searchInput.disabled = false;
        clearSearchBtn.disabled = false;
        setStats(`Sources: ${sources.length} | Nodes: ${filtered.nodes.length.toLocaleString()} | Edges: ${filtered.edges.length.toLocaleString()}`);
    }

    async function rebuildFromMergedWithFilter() {
        if (!mergedData) return;
        showOverlay('Rebuilding…', 10);
        const {nodes, edges} = await buildGraphAsync(mergedData, ({phase, done, total}) => {
            const base = phase === 'nodes' ? 10 : 40;
            const span = 30;
            const pct = total > 0 ? base + Math.min(1, done / total) * span : base;
            const msg = phase === 'nodes'
                ? `Building nodes… ${Math.min(100, Math.round((done / Math.max(1, total)) * 100))}%`
                : `Linking edges… ${Math.min(100, Math.round((done / Math.max(1, total)) * 100))}%`;
            showOverlay(msg, Math.round(pct));
        });
        const filtered = filterLeavesConnectedToRoots(nodes, edges);
        initNetwork(filtered.nodes, filtered.edges);
        setStats(`Sources: ${sources.length} | Nodes: ${filtered.nodes.length.toLocaleString()} | Edges: ${filtered.edges.length.toLocaleString()}`);
    }

    function highlightByUsernamePart(query) {
        if (!network || !nodesDS) return;
        const q = query.trim().toLowerCase();
        const allNodes = nodesDS.get();

        // Reset colors
        const dimColor = '#394b5a';
        const highlightNodeColor = {background: '#f6c177', border: '#845a2c'};

        const updates = [];
        for (const n of allNodes) {
            const base = baseColorById.get(n.id) || n.color || {background: '#4e79a7', border: '#2e4a67'};
            if (useAvatars) {
                updates.push({id: n.id, color: {border: base.border}, opacity: 1});
            } else {
                updates.push({id: n.id, color: base, opacity: 1});
            }
        }
        nodesDS.update(updates);

        if (!q) {
            clearSelection(false);
            return;
        }

        // Find nodes whose label includes query
        const matchedIds = new Set();
        for (const n of allNodes) {
            if (String(n.label).toLowerCase().includes(q)) {
                matchedIds.add(n.id);
            }
        }

        if (matchedIds.size === 0) return;

        // If exactly one match, behave like clicking it
        if (matchedIds.size === 1) {
            const only = matchedIds.values().next().value;
            setSelected(only, {focus: true, openSidebar: true});
            return;
        }

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
                const base = baseColorById.get(n.id) || n.color || {border: '#2e4a67'};
                if (useAvatars) {
                    dimUpdates.push({id: n.id, color: {border: base.border}, opacity: 0.35});
                } else {
                    dimUpdates.push({id: n.id, color: {background: dimColor, border: base.border}, opacity: 0.4});
                }
            }
        }
        nodesDS.update(dimUpdates);

        const hiUpdates = [];
        for (const id of matchedIds) {
            if (useAvatars) {
                const base = baseColorById.get(id) || {border: '#845a2c'};
                hiUpdates.push({id, color: {border: '#f6c177'}, opacity: 1, borderWidth: 3});
            } else {
                hiUpdates.push({id, color: highlightNodeColor, opacity: 1});
            }
        }
        for (const id of neighborIds) {
            if (!matchedIds.has(id)) {
                if (useAvatars) {
                    const base = baseColorById.get(id) || {border: '#2e4a67'};
                    hiUpdates.push({id, color: {border: base.border}, opacity: 0.9, borderWidth: 2});
                } else {
                    hiUpdates.push({id, color: {background: '#9cb9d9', border: '#2e4a67'}, opacity: 0.9});
                }
            }
        }
        nodesDS.update(hiUpdates);

        // Edge visibility: show only edges within matched ∪ neighbors
        const visibleSet = new Set([...matchedIds, ...neighborIds].map(String));
        updateEdgesVisibility(visibleSet);

        // Focus to the first match
        const first = matchedIds.values().next().value;
        if (first) network.focus(first, {scale: 1, animation: {duration: 500, easingFunction: 'easeInOutQuad'}});
    }

    function setSelected(id, opts = {}) {
        if (!network || !nodesDS) return;
        selectedId = id;
        const allNodes = nodesDS.get();
        const dimColor = '#394b5a';
        const highlightNodeColor = {background: '#f6c177', border: '#845a2c'};
        const neighbors = new Set(network.getConnectedNodes(id).map(String));

        const updates = [];
        for (const n of allNodes) {
            const base = baseColorById.get(n.id) || n.color || {background: '#4e79a7', border: '#2e4a67'};
            if (n.id === id) {
                if (useAvatars) {
                    updates.push({id: n.id, color: {border: '#f6c177'}, opacity: 1, borderWidth: 3});
                } else {
                    updates.push({id: n.id, color: highlightNodeColor, opacity: 1});
                }
            } else if (neighbors.has(n.id)) {
                if (useAvatars) {
                    updates.push({id: n.id, color: {border: base.border}, opacity: 0.9, borderWidth: 2});
                } else {
                    updates.push({id: n.id, color: {background: '#9cb9d9', border: base.border}, opacity: 0.9});
                }
            } else {
                if (useAvatars) {
                    updates.push({id: n.id, color: {border: base.border}, opacity: 0.35});
                } else {
                    updates.push({id: n.id, color: {background: dimColor, border: base.border}, opacity: 0.35});
                }
            }
        }
        nodesDS.update(updates);

        // Show only edges among selected + its neighbors
        const visibleSet = new Set([id, ...neighbors].map(String));
        updateEdgesVisibility(visibleSet);

        if (opts.focus) {
            network.focus(id, {scale: 1, animation: {duration: 500, easingFunction: 'easeInOutQuad'}});
        }

        if (opts.openSidebar) {
            renderSidebar(id, neighbors);
        }
    }

    function clearSelection(resetSearch = true) {
        if (!nodesDS) return;
        selectedId = null;
        const allNodes = nodesDS.get();
        const updates = [];
        for (const n of allNodes) {
            const base = baseColorById.get(n.id) || n.color || {background: '#4e79a7', border: '#2e4a67'};
            if (useAvatars) {
                updates.push({id: n.id, color: {border: base.border}, opacity: 1, borderWidth: 2});
            } else {
                updates.push({id: n.id, color: base, opacity: 1});
            }
        }
        nodesDS.update(updates);
        // Restore all edges
        updateEdgesVisibility(null);
        hideSidebar();
        if (resetSearch) {
            searchInput.value = '';
        }
    }

    function renderSidebar(id, neighborIdsSet) {
        if (!mergedData) return;
        const label = nodesDS.get(id)?.label || id;
        sidebarTitle.textContent = label;

        // Group mutuals by source
        const blocks = [];
        for (const src of sources) {
            const info = src.data[id];
            let mutuals = [];
            if (info && Array.isArray(info.mutual)) {
                mutuals = info.mutual.filter(m => mergedData[m]);
            }
            const count = mutuals.length;
            // Skip sources with 0 mutuals entirely (do not render a block)
            if (count === 0) continue;
            const items = mutuals.slice(0, 200).map(mid => {
                const nm = mergedData[mid]?.name;
                // Per requirement: do not show IDs in mutuals when a name exists; otherwise fall back to ID
                return `<li>${nm && nm !== mid ? nm : mid}</li>`;
            }).join('');

            // Determine a friendly source label: if the source base name looks like an ID and
            // we have a mapped name for it in mergedData, show that name; otherwise show the base name
            const base = baseFileName(src.name);
            let sourceLabel = base;
            const looksLikeId = /^\d{15,22}$/.test(base);
            if (looksLikeId && mergedData[base] && mergedData[base].name && mergedData[base].name !== base) {
                sourceLabel = mergedData[base].name;
            }
            blocks.push(`
        <div class="source-block">
          <div class="source-title">${sourceLabel} — ${count} mutual${count === 1 ? '' : 's'}</div>
          <ul class="mutuals-list">${items}</ul>
        </div>
      `);
        }

        // If no sources had mutuals to show, render a friendly empty state
        sidebarContent.innerHTML = blocks.length
            ? blocks.join('')
            : '<div class="source-empty">No mutuals for this user in the loaded sources.</div>';
        showSidebar();
    }

    // Events
    fileInput.addEventListener('change', (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        loadFromFiles(files);
    });

    avatarToggle.addEventListener('change', (e) => {
        applyAvatarMode(e.target.checked);
    });

    hideNamesToggle.addEventListener('change', (e) => {
        applyHideUsernames(e.target.checked);
    });

    hideRootLeavesToggle.addEventListener('change', async (e) => {
        hideLeaves = !!e.target.checked;
        // Rebuild from merged data to apply/remove filtering
        await rebuildFromMergedWithFilter();
    });

    searchInput.addEventListener('input', (e) => {
        const value = e.target.value || '';
        // debounce via rAF
        if (searchInput._raf) cancelAnimationFrame(searchInput._raf);
        searchInput._raf = requestAnimationFrame(() => highlightByUsernamePart(value));
    });

    clearSearchBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearSelection();
    });

    sidebarClose.addEventListener('click', () => {
        clearSelection();
    });
})();
