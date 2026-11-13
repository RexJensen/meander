/* Meander core: map-data loading, scenic scoring, routing, loops, transit. No DOM. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(this, function () {
  'use strict';
  const rad = Math.PI / 180;
  const WALK = 80; // metres per minute (4.8 km/h)
  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];

  function dist(lat1, lon1, lat2, lon2) {
    const x = (lon2 - lon1) * rad * Math.cos((lat1 + lat2) / 2 * rad), y = (lat2 - lat1) * rad;
    return Math.sqrt(x * x + y * y) * 6371000;
  }
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  /* ---------- Overpass ---------- */
  async function overpass(query, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (typeof window === 'undefined') headers['User-Agent'] = 'meander-walk-app/1.0';
    const body = 'data=' + encodeURIComponent(query);
    const tryOne = async (url) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), opts.timeout || 60000);
      try {
        const r = await fetch(url, { method: 'POST', body, headers, signal: ctl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (!j || !j.elements) throw new Error('bad response');
        if (j.remark && /runtime error|timed out/i.test(j.remark)) throw new Error(j.remark);
        return j;
      } finally { clearTimeout(t); }
    };
    // hedged: start the next mirror if the previous has not answered in 7 s or failed
    return new Promise((resolve, reject) => {
      let i = 0, pending = 0, done = false, lastErr, timer;
      const launch = () => {
        if (done || i >= OVERPASS.length) return;
        const url = OVERPASS[i++]; pending++;
        clearTimeout(timer);
        timer = setTimeout(launch, 7000);
        tryOne(url).then(j => { if (!done) { done = true; clearTimeout(timer); resolve(j); } })
          .catch(e => { lastErr = e; pending--; if (done) return; if (i < OVERPASS.length) launch(); else if (!pending) { clearTimeout(timer); reject(lastErr); } });
      };
      launch();
    });
  }

  function areaQuery(b) {
    const B = b.map(v => v.toFixed(5)).join(',');
    return `[out:json][timeout:50];
way[highway][highway!~"^(motorway|motorway_link|construction|proposed|bus_guideway|raceway|platform|elevator|rest_area|services|corridor)$"](${B});
out geom qt;
(
way[leisure~"^(park|garden|nature_reserve|common)$"](${B});
relation[leisure~"^(park|garden|nature_reserve)$"](${B});
way[landuse~"^(forest|meadow|grass|village_green|recreation_ground|cemetery|industrial|railway)$"](${B});
way[natural~"^(wood|scrub|beach|tree_row)$"](${B});
way[tourism~"^(attraction|museum|gallery|artwork|viewpoint)$"](${B});
way[historic~"^(monument|castle|ruins|fort|city_gate|ship|memorial|building|church)$"](${B});
node[tourism~"^(attraction|museum|gallery|artwork|viewpoint)$"](${B});
node[historic~"^(monument|castle|ruins|fort|city_gate|ship)$"](${B});
node[amenity=fountain](${B});
);
out geom qt;
(
way[natural~"^(water|coastline)$"](${B});
way[waterway~"^(river|canal|stream|riverbank|dock)$"](${B});
relation[natural=water](${B});
);
out geom(${B}) qt;`;
  }

  /* ---------- raster fields ---------- */
  function Grid(w, h) { return { w, h, d: new Float32Array(w * h) }; }
  function fillRings(g, rings, val, idGrid, id) {
    let minY = Infinity, maxY = -Infinity;
    for (const r of rings) for (const p of r) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(g.h - 1, Math.ceil(maxY));
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5; xs.length = 0;
      for (const r of rings) {
        for (let i = 0, n = r.length; i < n; i++) {
          const a = r[i], b = r[(i + 1) % n];
          if ((a[1] <= yc) !== (b[1] <= yc)) xs.push(a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.max(0, Math.ceil(xs[i] - 0.5)), xb = Math.min(g.w - 1, Math.floor(xs[i + 1] - 0.5));
        for (let x = xa, o = y * g.w + xa; x <= xb; x++, o++) { if (g.d[o] < val) g.d[o] = val; if (idGrid) idGrid[o] = id; }
      }
    }
  }
  function stamp(g, cx, cy, r, val, idGrid, id) {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(g.w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(g.h - 1, Math.ceil(cy + r));
    const r2 = r * r + 0.5;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) { const o = y * g.w + x; if (g.d[o] < val) g.d[o] = val; if (idGrid) idGrid[o] = id; }
    }
  }
  function stroke(g, pts, r, val, idGrid, id) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (!a || !b) continue;
      // skip segments wholly outside
      if ((a[0] < -r && b[0] < -r) || (a[1] < -r && b[1] < -r) || (a[0] > g.w + r && b[0] > g.w + r) || (a[1] > g.h + r && b[1] > g.h + r)) continue;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / Math.max(0.7, r * 0.6)));
      for (let k = 0; k <= n; k++) {
        const x = a[0] + (b[0] - a[0]) * k / n, y = a[1] + (b[1] - a[1]) * k / n;
        if (x < -r || y < -r || x > g.w + r || y > g.h + r) continue;
        stamp(g, x, y, r, val, idGrid, id);
      }
    }
  }
  function blur(g, r) {
    if (r < 1) return;
    const { w, h, d } = g, t = new Float32Array(w * h), win = 2 * r + 1;
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++) { // horizontal d -> t
        let s = 0; const o = y * w;
        for (let x = -r; x <= r; x++) s += d[o + clamp(x, 0, w - 1)];
        for (let x = 0; x < w; x++) { t[o + x] = s / win; s += d[o + Math.min(w - 1, x + r + 1)] - d[o + Math.max(0, x - r)]; }
      }
      for (let x = 0; x < w; x++) { // vertical t -> d
        let s = 0;
        for (let y = -r; y <= r; y++) s += t[clamp(y, 0, h - 1) * w + x];
        for (let y = 0; y < h; y++) { d[y * w + x] = s / win; s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x]; }
      }
    }
  }
  function stitch(parts) {
    const rings = [], open = [];
    for (const p of parts) { if (p.length < 2) continue; const a = p[0], b = p[p.length - 1]; if (a[0] === b[0] && a[1] === b[1]) rings.push(p); else open.push(p.slice()); }
    while (open.length) {
      let cur = open.pop(), grew = true;
      while (grew) {
        grew = false;
        const e = cur[cur.length - 1];
        if (e[0] === cur[0][0] && e[1] === cur[0][1] && cur.length > 2) break;
        for (let i = 0; i < open.length; i++) {
          const o = open[i], oa = o[0], ob = o[o.length - 1];
          if (oa[0] === e[0] && oa[1] === e[1]) { cur = cur.concat(o.slice(1)); open.splice(i, 1); grew = true; break; }
          if (ob[0] === e[0] && ob[1] === e[1]) { cur = cur.concat(o.slice(0, -1).reverse()); open.splice(i, 1); grew = true; break; }
        }
      }
      if (cur.length > 3) rings.push(cur);
    }
    return rings;
  }

  /* ---------- area (graph + fields) ---------- */
  const BASE = { pedestrian: .6, footway: .5, path: .5, steps: .42, living_street: .5, residential: .4, cycleway: .38, track: .45, bridleway: .45, service: .2, unclassified: .3, road: .25, tertiary: .25, tertiary_link: .2, secondary: .15, secondary_link: .12, primary: .08, primary_link: .06, trunk: .03, trunk_link: .03 };
  const MAJOR = { trunk: 1, trunk_link: 1, primary: .8, primary_link: .6, secondary: .5, motorway: 1 };
  const NICE_NAME = /promenade|riverwalk|river walk|esplanade|greenway|embankment|boardwalk|harborwalk|harbourside|towpath|waterfront|\bmall\b|\bmews\b/i;

  function walkable(t) {
    const hw = t.highway;
    if (!(hw in BASE)) return false;
    const foot = t.foot, acc = t.access;
    if (foot === 'no' || foot === 'private') return false;
    const footOK = foot === 'yes' || foot === 'designated' || foot === 'permissive';
    if ((acc === 'no' || acc === 'private' || acc === 'customers') && !footOK) return false;
    if (t.indoor === 'yes' || t.tunnel === 'building_passage' && hw === 'footway' && t.level) return false;
    if (hw === 'service' && /^(parking_aisle|driveway|drive-through|emergency_access)$/.test(t.service || '')) return false;
    if ((hw === 'trunk' || hw === 'trunk_link') && !footOK && !/^(both|left|right|yes|separate)$/.test(t.sidewalk || '')) return false;
    if (hw === 'cycleway' && !footOK && t.segregated !== 'yes' && t.sidewalk == null && foot == null) return true; // most shared in practice
    return true;
  }

  function buildArea(json, bbox, cfg) {
    cfg = cfg || {};
    const [S, W, N, E] = bbox;
    const kx = 111320 * Math.cos((S + N) / 2 * rad), ky = 110540;
    const wM = (E - W) * kx, hM = (N - S) * ky;
    const cell = Math.max(12, Math.max(wM, hM) / 700);
    const gw = Math.ceil(wM / cell) + 1, gh = Math.ceil(hM / cell) + 1;
    const GX = lon => (lon - W) * kx / cell, GY = lat => (lat - S) * ky / cell;
    const gp = p => p ? [GX(p.lon), GY(p.lat)] : null;
    const green = Grid(gw, gh), water = Grid(gw, gh), poi = Grid(gw, gh), bad = Grid(gw, gh), traf = Grid(gw, gh), cur = Grid(gw, gh);
    const parkId = new Int16Array(gw * gh), nameId = new Int32Array(gw * gh);
    const parkNames = [''], highlights = [];
    const meta = []; // per way: {name, hw, ...}
    const nodeIdx = new Map(); const nx = [], ny = [];
    const ea = [], eb = [], el = [], em = [];
    let virt = -1;
    const addNode = (id, x, y) => { let i = nodeIdx.get(id); if (i === undefined) { i = nx.length; nodeIdx.set(id, i); nx.push(x); ny.push(y); } return i; };

    for (const e of json.elements) {
      const t = e.tags || {};
      if (e.type === 'way' && t.highway && e.geometry && e.nodes) {
        const hw = t.highway;
        const pts = e.geometry.map(gp);
        if (MAJOR[hw]) stroke(traf, pts, (hw === 'trunk' || hw === 'motorway' ? 30 : hw === 'primary' ? 20 : 15) / cell, MAJOR[hw]);
        if (walkable(t)) {
          const mi = meta.length;
          meta.push({ name: t.name || '', hw, side: t.footway === 'sidewalk' || t.footway === 'crossing', lit: t.lit === 'yes' ? 1 : t.lit === 'no' ? -1 : 0, tunnel: !!t.tunnel && t.tunnel !== 'no', bridge: !!t.bridge && t.bridge !== 'no', steps: hw === 'steps' });
          if (t.name && hw !== 'steps') strokeId(nameId, gw, gh, pts, Math.max(1.2, 16 / cell), mi + 1);
          for (let i = 0; i + 1 < e.nodes.length; i++) {
            const A = e.geometry[i], B = e.geometry[i + 1]; if (!A || !B) continue;
            const ax = (A.lon - W) * kx, ay = (A.lat - S) * ky, bx = (B.lon - W) * kx, by = (B.lat - S) * ky;
            const L = Math.hypot(bx - ax, by - ay);
            const parts = Math.max(1, Math.round(L / 45));
            let prev = addNode(e.nodes[i], ax, ay);
            for (let k = 1; k <= parts; k++) {
              const nxt = k === parts ? addNode(e.nodes[i + 1], bx, by) : addNode(virt--, ax + (bx - ax) * k / parts, ay + (by - ay) * k / parts);
              if (nxt !== prev) { ea.push(prev); eb.push(nxt); el.push(L / parts); em.push(mi); }
              prev = nxt;
            }
          }
        }
      }
      // scenic features
      let gval = 0, isBad = false, isWater = false, isPoi = false;
      if (/^(park|garden|nature_reserve|common)$/.test(t.leisure || '')) gval = 1;
      else if (/^(wood|scrub|beach)$/.test(t.natural || '') || t.landuse === 'forest') gval = 1;
      else if (/^(meadow|grass|village_green|recreation_ground|cemetery)$/.test(t.landuse || '')) gval = .6;
      if (t.landuse === 'industrial' || t.landuse === 'railway') isBad = true;
      if (t.natural === 'water' || t.natural === 'coastline' || (t.waterway && !t.highway)) isWater = true;
      if (/^(attraction|museum|gallery|artwork|viewpoint)$/.test(t.tourism || '') || (t.historic && !t.highway) || t.amenity === 'fountain') isPoi = true;
      if (!gval && !isBad && !isWater && !isPoi && t.natural !== 'tree_row') continue;

      let parts = [];
      if (e.type === 'way' && e.geometry) parts = [e.geometry.map(gp)];
      else if (e.type === 'relation' && e.members) for (const m of e.members) if (m.type === 'way' && m.geometry) parts.push(m.geometry.map(gp));
      if (t.natural === 'tree_row') { for (const p of parts) stroke(green, p, 1.3, .55); continue; }
      if (isWater) {
        const r = Math.max(2, (t.waterway && t.natural !== 'water' ? 45 : 38) / cell);
        for (const p of parts) stroke(water, p, r, t.waterway === 'stream' ? .6 : 1);
      }
      if (gval || isBad) {
        const clean = parts.map(p => p.filter(Boolean)).filter(p => p.length > 1);
        const rings = stitch(clean);
        if (rings.length) {
          if (gval) {
            let id = 0;
            if (t.name && gval === 1 && parkNames.length < 32000) { id = parkNames.length; parkNames.push(t.name); }
            fillRings(green, rings, gval, id ? parkId : null, id);
          } else fillRings(bad, rings, 1);
        }
      }
      if (isPoi) {
        let c = null;
        if (e.type === 'node') c = [GX(e.lon), GY(e.lat)];
        else if (parts.length && parts[0].length) { let sx = 0, sy = 0, n = 0; for (const p of parts[0]) if (p) { sx += p[0]; sy += p[1]; n++; } if (n) c = [sx / n, sy / n]; }
        if (c) {
          const notable = !!(t.wikidata || t.wikipedia);
          stamp(poi, c[0], c[1], (notable ? 70 : 45) / cell, notable ? 1 : .6);
          const big = /^(attraction|museum|viewpoint)$/.test(t.tourism || '') || /^(castle|monument|fort|city_gate|ship)$/.test(t.historic || '');
          if (t.name && big && (notable || t.tourism === 'viewpoint') && !/^(memorial|statue)$/.test(t.historic || '')) highlights.push({ name: t.name, x: c[0] * cell, y: c[1] * cell });
        }
      }
    }
    for (const s of (cfg.spots || [])) {
      const pts = s.pts || [[s.lat, s.lon]];
      for (const p of pts) stamp(cur, GX(p[1]), GY(p[0]), (s.r || 120) / cell, 1);
      highlights.push({ name: s.n, curated: true, r: s.r || 120, pts: pts.map(p => [(p[1] - W) * kx, (p[0] - S) * ky]), note: s.t || '' });
    }
    const bl = m => Math.max(1, Math.round(m / cell));
    blur(green, bl(22)); blur(water, bl(30)); blur(poi, bl(25)); blur(bad, bl(15)); blur(traf, bl(10)); blur(cur, bl(25));

    const n = nx.length, m = ea.length;
    const X = Float32Array.from(nx), Y = Float32Array.from(ny);
    const EA = Int32Array.from(ea), EB = Int32Array.from(eb), EL = Float32Array.from(el), EM = Int32Array.from(em);
    const ES = new Float32Array(m), ED = new Float32Array(m), EK = new Float32Array(m), EZ = new Uint8Array(m), EF = new Uint8Array(m), EP = new Int16Array(m), EN = new Int32Array(m);
    const zones = (cfg.zones || []).map(z => ({ n: z.n, sev: z.sev || .8, x: (z.lon - W) * kx, y: (z.lat - S) * ky, r: z.r, note: z.t || '' }));
    const samp = (g, x, y) => { const cx = clamp(Math.floor(x / cell), 0, gw - 1), cy = clamp(Math.floor(y / cell), 0, gh - 1); return g.d[cy * gw + cx]; };
    for (let i = 0; i < m; i++) {
      const mt = meta[EM[i]], x = (X[EA[i]] + X[EB[i]]) / 2, y = (Y[EA[i]] + Y[EB[i]]) / 2;
      const o = clamp(Math.floor(y / cell), 0, gh - 1) * gw + clamp(Math.floor(x / cell), 0, gw - 1);
      const g = Math.min(1, green.d[o] * 1.3), w = Math.min(1, water.d[o] * 1.6), p = Math.min(1, poi.d[o] * 2), b = bad.d[o], c = Math.min(1, cur.d[o] * 1.5), tr = Math.min(1, traf.d[o] * 1.5);
      const footish = !(mt.hw in MAJOR) && /^(footway|path|pedestrian|steps|cycleway|track|bridleway)$/.test(mt.hw);
      let s = mt.side ? .28 : BASE[mt.hw];
      s += .42 * g + .45 * w + .2 * p + .3 * c - .35 * b;
      if (footish || mt.hw === 'residential' || mt.hw === 'living_street' || mt.hw === 'service') s -= .2 * tr * (1 - .6 * Math.max(g, w));
      if (mt.tunnel) s -= .15;
      if (mt.name && NICE_NAME.test(mt.name)) s += .1;
      ES[i] = clamp(s, .02, 1);
      let f = 0;
      if (green.d[o] > .5) f |= 1;
      if (w > .45) f |= 2;
      if (MAJOR[mt.hw] || (tr > .55 && g < .5 && w < .5)) f |= 4;
      if (mt.steps) f |= 8;
      EF[i] = f; EP[i] = parkId[o];
      EN[i] = mt.name ? EM[i] + 1 : nameId[o];
      let dk = 0;
      if (mt.lit === -1) dk = 1; else if (mt.lit === 0) dk = footish && !mt.side ? (green.d[o] > .5 ? .9 : .35) : 0;
      if (mt.tunnel && footish) dk = Math.max(dk, .6);
      EK[i] = dk;
      for (let zi = 0; zi < zones.length; zi++) { const z = zones[zi], dx = x - z.x, dy = y - z.y; if (dx * dx + dy * dy < z.r * z.r && z.sev > ED[i]) { ED[i] = z.sev; EZ[i] = zi + 1; } }
    }
    // adjacency CSR
    const deg = new Int32Array(n + 1);
    for (let i = 0; i < m; i++) { deg[EA[i] + 1]++; deg[EB[i] + 1]++; }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const adjN = new Int32Array(2 * m), adjE = new Int32Array(2 * m), fill = deg.slice(0, n);
    for (let i = 0; i < m; i++) { let a = EA[i], b = EB[i]; adjN[fill[a]] = b; adjE[fill[a]++] = i; adjN[fill[b]] = a; adjE[fill[b]++] = i; }
    // components
    const comp = new Int32Array(n).fill(-1); let best = -1, bestSize = 0, nc = 0; const stack = [];
    for (let i = 0; i < n; i++) if (comp[i] < 0) {
      let size = 0; stack.push(i); comp[i] = nc;
      while (stack.length) { const u = stack.pop(); size++; for (let k = deg[u]; k < deg[u + 1]; k++) { const v = adjN[k]; if (comp[v] < 0) { comp[v] = nc; stack.push(v); } } }
      if (size > bestSize) { bestSize = size; best = nc; } nc++;
    }
    // node scores + buckets
    const NS = new Float32Array(n), ND = new Float32Array(n);
    for (let i = 0; i < m; i++) { const a = EA[i], b = EB[i]; if (ES[i] > NS[a]) NS[a] = ES[i]; if (ES[i] > NS[b]) NS[b] = ES[i]; if (ED[i] > ND[a]) ND[a] = ED[i]; if (ED[i] > ND[b]) ND[b] = ED[i]; }
    const BC = 90, bw = Math.ceil(wM / BC) + 2, buckets = new Map();
    for (let i = 0; i < n; i++) if (comp[i] === best) { const k = Math.floor(Y[i] / BC) * bw + Math.floor(X[i] / BC); let a = buckets.get(k); if (!a) buckets.set(k, a = []); a.push(i); }
    return {
      bbox, kx, ky, cell, gw, gh, n, m, X, Y, EA, EB, EL, EM, ES, ED, EK, EZ, EF, EP, EN, deg, adjN, adjE, comp, main: best, NS, ND, meta, zones, parkNames, highlights, buckets, BC, bw,
      toXY: (lat, lon) => [(lon - W) * kx, (lat - S) * ky],
      toLL: (x, y) => [S + y / ky, W + x / kx],
      dist: new Float64Array(n), prev: new Int32Array(n), prevE: new Int32Array(n),
    };
  }
  function strokeId(arr, w, h, pts, r, id) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1]; if (!a || !b) continue;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / .8));
      for (let k = 0; k <= n; k++) {
        const cx = a[0] + (b[0] - a[0]) * k / n, cy = a[1] + (b[1] - a[1]) * k / n;
        const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.floor(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.floor(cy + r));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) arr[y * w + x] = id;
      }
    }
  }

  function nearestNode(A, x, y, maxR) {
    const { BC, bw, buckets, X, Y } = A; let best = -1, bd = Infinity;
    const cx = Math.floor(x / BC), cy = Math.floor(y / BC), rings = Math.ceil((maxR || 600) / BC);
    for (let r = 0; r <= rings; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const a = buckets.get((cy + dy) * bw + cx + dx); if (!a) continue;
        for (const i of a) { const d = (X[i] - x) ** 2 + (Y[i] - y) ** 2; if (d < bd) { bd = d; best = i; } }
      }
      if (best >= 0 && Math.sqrt(bd) < r * BC) break;
    }
    return best;
  }
  function bestScenicNode(A, x, y, R) {
    const { BC, bw, buckets, X, Y, NS, ND } = A; let best = -1, bs = -Infinity;
    const cx = Math.floor(x / BC), cy = Math.floor(y / BC), rings = Math.ceil(R / BC);
    for (let dy = -rings; dy <= rings; dy++) for (let dx = -rings; dx <= rings; dx++) {
      const a = buckets.get((cy + dy) * bw + cx + dx); if (!a) continue;
      for (const i of a) { const d = Math.hypot(X[i] - x, Y[i] - y); if (d > R) continue; const s = NS[i] - .25 * d / R - 2 * ND[i]; if (s > bs) { bs = s; best = i; } }
    }
    return best;
  }

  /* ---------- A* ---------- */
  function astar(A, src, dst, P) {
    const { X, Y, deg, adjN, adjE, EL, ES, ED, EK, EF, dist: D, prev, prevE } = A;
    const k = P.k || 0, kd = P.kd || 0, kn = P.night ? (P.kn == null ? 1.2 : P.kn) : 0, used = P.used || null;
    D.fill(Infinity);
    const hk = [], hv = [];
    const push = (key, v) => { let i = hk.length; hk.push(key); hv.push(v); while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= key) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; } hk[i] = key; hv[i] = v; };
    const pop = () => { const top = hv[0], lk = hk.pop(), lv = hv.pop(), n = hk.length; if (n) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && hk[c + 1] < hk[c]) c++; if (hk[c] >= lk) break; hk[i] = hk[c]; hv[i] = hv[c]; i = c; } hk[i] = lk; hv[i] = lv; } return top; };
    const tx = X[dst], ty = Y[dst];
    D[src] = 0; prev[src] = -1; push(Math.hypot(X[src] - tx, Y[src] - ty), src);
    while (hk.length) {
      const key = hk[0], u = pop();
      if (u === dst) break;
      const du = D[u];
      if (key > du + Math.hypot(X[u] - tx, Y[u] - ty) + 1e-6) continue;
      for (let j = deg[u]; j < deg[u + 1]; j++) {
        const e = adjE[j], v = adjN[j];
        let c = EL[e] * (1 + k * (1 - ES[e]) + kd * ED[e] + kn * EK[e]);
        if (EF[e] & 8) c *= 1.5;
        if (used && used[e]) c *= 3;
        const nd = du + c;
        if (nd < D[v]) { D[v] = nd; prev[v] = u; prevE[v] = e; push(nd + Math.hypot(X[v] - tx, Y[v] - ty), v); }
      }
    }
    if (D[dst] === Infinity) return null;
    const nodes = [], edges = [];
    for (let u = dst; u !== -1; u = prev[u]) { nodes.push(u); if (prev[u] !== -1) edges.push(prevE[u]); }
    nodes.reverse(); edges.reverse();
    return { nodes, edges };
  }

  /* ---------- route description ---------- */
  function describe(A, path, night) {
    const { EL, ES, ED, EK, EZ, EF, EP, EN, X, Y, meta } = A;
    let len = 0, mins = 0, sS = 0, park = 0, wat = 0, maj = 0, dark = 0, dangerM = 0;
    const zoneM = {}, parkM = {};
    const coords = path.nodes.map(i => A.toLL(X[i], Y[i]));
    const flags = [];
    for (const e of path.edges) {
      const L = EL[e]; len += L; mins += L / WALK * (EF[e] & 8 ? 1.6 : 1); sS += ES[e] * L;
      if (EF[e] & 1) park += L; if (EF[e] & 2) wat += L; if (EF[e] & 4) maj += L;
      if (EK[e] > .5) dark += L;
      if (EZ[e]) { dangerM += L; zoneM[EZ[e]] = (zoneM[EZ[e]] || 0) + L; }
      if (EP[e]) parkM[EP[e]] = (parkM[EP[e]] || 0) + L;
      flags.push(EZ[e] ? 1 : (night && EK[e] > .5 ? 2 : 0));
    }
    // highlights
    const hl = [], seen = new Set();
    const step = Math.max(1, Math.floor(path.nodes.length / 400));
    for (const h of A.highlights) {
      if (seen.has(h.name)) continue;
      const R = h.curated ? h.r : 55, pts = h.curated ? h.pts : [[h.x, h.y]];
      let hit = false;
      outer: for (let i = 0; i < path.nodes.length; i += step) { const u = path.nodes[i]; for (const p of pts) if ((X[u] - p[0]) ** 2 + (Y[u] - p[1]) ** 2 < R * R) { hit = true; break outer; } }
      if (hit) { seen.add(h.name); hl.push({ name: h.name, curated: !!h.curated, note: h.note || '' }); }
    }
    hl.sort((a, b) => (b.curated ? 1 : 0) - (a.curated ? 1 : 0));
    const meanS = len ? sS / len : 0;
    const pct = v => len ? Math.round(100 * v / len) : 0;
    return {
      coords, flags, len, mins, meanS, nice: Math.round(100 * clamp((meanS - .08) / .82, 0, 1)),
      pPark: pct(park), pWater: pct(wat), pMajor: pct(maj), darkM: dark, dangerM,
      danger: Object.keys(zoneM).map(k => ({ name: A.zones[k - 1].n, note: A.zones[k - 1].note, m: Math.round(zoneM[k]) })).filter(z => z.m > 40).sort((a, b) => b.m - a.m),
      parks: Object.keys(parkM).map(k => ({ name: A.parkNames[k], m: Math.round(parkM[k]) })).filter(p => p.m > 80).sort((a, b) => b.m - a.m).slice(0, 4),
      highlights: hl.slice(0, 6), steps: directions(A, path),
    };
  }
  function directions(A, path) {
    const { EL, EN, EM, EP, EF, X, Y, meta, parkNames } = A, out = [];
    const label = e => {
      const mt = meta[EM[e]];
      if (mt.name) return mt.name;
      if (EF[e] & 8) return 'stairs';
      if (EP[e]) return 'path through ' + parkNames[EP[e]];
      if (EN[e]) return meta[EN[e] - 1].name;
      return mt.hw === 'footway' || mt.hw === 'path' || mt.hw === 'pedestrian' ? 'footpath' : 'unnamed street';
    };
    let cur = null;
    for (let i = 0; i < path.edges.length; i++) {
      const e = path.edges[i], lb = label(e), full = lb;
      if (cur && cur.key === lb) { cur.dist += EL[e]; cur.end = i + 1; continue; }
      cur = { key: lb, name: full, dist: EL[e], start: i, end: i + 1 }; out.push(cur);
    }
    // merge tiny segments into the following
    const merged = [];
    for (const s of out) { const l = merged[merged.length - 1]; if (l && ((s.dist < 18 && s.key !== 'stairs') || l.key === s.key)) { l.dist += s.dist; l.end = s.end; } else merged.push(s); }
    const brg = (a, b) => Math.atan2(X[b] - X[a], Y[b] - Y[a]) / rad;
    const res = [];
    for (let i = 0; i < merged.length; i++) {
      const s = merged[i]; let verb = 'Head along';
      if (i > 0) {
        const j = s.start, n0 = path.nodes[Math.max(0, j - 2)], n1 = path.nodes[j], n2 = path.nodes[Math.min(path.nodes.length - 1, j + 2)];
        let d = brg(n1, n2) - brg(n0, n1); while (d > 180) d -= 360; while (d < -180) d += 360;
        verb = Math.abs(d) < 25 ? 'Continue on' : Math.abs(d) < 60 ? (d > 0 ? 'Bear right onto' : 'Bear left onto') : (d > 0 ? 'Turn right onto' : 'Turn left onto');
      }
      if (s.key === 'stairs') verb = 'Take the';
      res.push({ text: verb + ' ' + s.name, m: Math.round(s.dist), i: s.start });
    }
    return res;
  }

  /* ---------- A to B planning ---------- */
  function utility(r, night) { return r.meanS - 2.5 * r.dangerM / Math.max(200, r.len) - (night ? .4 * r.darkM / Math.max(200, r.len) : 0); }
  function diffText(a, b) { // what b has that a lacks
    const parts = [];
    if (b.pPark - a.pPark >= 8) parts.push(`${b.pPark}% through parks (vs ${a.pPark}%)`);
    if (b.pWater - a.pWater >= 8) parts.push(`${b.pWater}% along the water (vs ${a.pWater}%)`);
    if (a.pMajor - b.pMajor >= 10) parts.push(`busy roads drop from ${a.pMajor}% to ${b.pMajor}%`);
    const an = new Set(a.highlights.map(h => h.name)), nh = b.highlights.filter(h => !an.has(h.name)).slice(0, 2).map(h => h.name);
    if (nh.length) parts.push('passes ' + nh.join(' and '));
    if (a.dangerM - b.dangerM > 100) parts.push('less time in higher-crime areas');
    if (!parts.length) parts.push('quieter, more pleasant streets');
    return parts.join(', ');
  }
  function planWalk(A, from, to, opts) {
    opts = opts || {};
    const night = !!opts.night, extra = opts.extraMin || 0;
    const [fx, fy] = A.toXY(from.lat, from.lon), [tx, ty] = A.toXY(to.lat, to.lon);
    const s = nearestNode(A, fx, fy, 800), d = nearestNode(A, tx, ty, 800);
    if (s < 0 || d < 0) return { error: 'No walkable streets found near one of the points.' };
    const runs = [{ k: 0, kd: 0, kn: 0 }, { k: 0, kd: 8 }, { k: .35, kd: 8 }, { k: .8, kd: 8 }, { k: 1.5, kd: 8 }, { k: 3, kd: 9 }, { k: 6, kd: 10 }];
    const cands = [], seen = new Set();
    for (const P of runs) {
      const p = astar(A, s, d, { k: P.k, kd: P.kd, night, kn: P.kn });
      if (!p) return { error: 'Could not find a walking route between these points.' };
      let h = 0; for (const e of p.edges) h = (h * 31 + e) | 0;
      const key = h + ':' + p.edges.length; if (seen.has(key)) continue; seen.add(key);
      const r = describe(A, p, night); r.k = P.k;
      // drop near-duplicates: same time within 20s and same niceness
      r.u = utility(r, night);
      const dup = cands.findIndex(c => Math.abs(c.mins - r.mins) < 1 && Math.abs(c.meanS - r.meanS) < .05 && Math.abs(c.dangerM - r.dangerM) < 40);
      if (dup > 0) { if (r.u > cands[dup].u) cands[dup] = r; continue; }
      if (dup === 0) { if (r.mins - cands[0].mins < .4) continue; }
      cands.push(r);
    }
    cands.sort((a, b) => a.mins - b.mins);
    const fastest = cands[0], limit = fastest.mins + extra + .5;
    let chosen = 0, bu = -Infinity;
    cands.forEach((c, i) => { c.extra = c.mins - fastest.mins; if (c.mins <= limit && c.u > bu + 1e-9) { bu = c.u; chosen = i; } });
    let nicest = 0, safest = 0; cands.forEach((c, i) => { if (c.meanS > cands[nicest].meanS) nicest = i; if (c.dangerM < cands[safest].dangerM - 40) safest = i; });
    cands.forEach((c, i) => { c.label = i === 0 ? 'Fastest' : i === nicest ? 'Nicest' : (i === safest && fastest.dangerM > 50) ? 'Safest' : c.extra < 3.5 ? 'Slight detour' : 'Scenic'; });
    return { cands, chosen, tradeoffs: tradeoffs(cands, chosen, extra, night, opts.fmt) };
  }
  const mm = v => Math.max(1, Math.round(v));
  function tradeoffs(cands, ci, extra, night, fmt) {
    const c = cands[ci], out = [], fastest = cands[0]; fmt = fmt || (m => Math.round(m / 10) * 10 + ' m');
    if (c.dangerM > 50) {
      let alt = -1, as = Infinity;
      cands.forEach((x, i) => { if (x.dangerM <= .6 * c.dangerM) { const sc = (x.mins - c.mins) + x.dangerM / 35; if (sc < as) { as = sc; alt = i; } } });
      const names = c.danger.map(z => z.name).join(' and ') || 'a higher-crime area';
      if (alt >= 0) {
        const x = cands[alt], keep = new Set(x.danger.map(z => z.name)), gone = c.danger.map(z => z.name).filter(n => !keep.has(n));
        const what = x.dangerM < 40 ? 'avoids it entirely' : gone.length ? `avoids ${gone.join(' and ')} (${fmt(x.dangerM)} still in ${x.danger.map(z => z.name).join(' and ')})` : `cuts that to ${fmt(x.dangerM)}`;
        out.push({ kind: 'warn', idx: alt, text: `Heads up: this route runs about ${fmt(c.dangerM)} through ${names}, where reported crime is higher. A route that ${what} takes ${mm(x.mins - c.mins)} more min${x.nice > c.nice + 5 ? ' and is a nicer walk too' : ''}.`, cta: `Take the safer route (+${mm(x.mins - c.mins)} min)` });
      } else out.push({ kind: 'warn', text: `Heads up: about ${fmt(c.dangerM)} of this walk is in ${names}, where reported crime is higher. There is no practical way around it on foot here${night ? '; consider the subway or a ride after dark' : ''}.` });
    }
    if (night && c.darkM > 150) {
      let alt = -1; cands.forEach((x, i) => { if (x.darkM < .4 * c.darkM && x.dangerM <= c.dangerM + 40 && (alt < 0 || x.mins < cands[alt].mins)) alt = i; });
      if (alt >= 0 && alt !== ci) out.push({ kind: 'warn', idx: alt, text: `After dark: about ${fmt(c.darkM)} of this route is on unlit park paths. A better-lit route is ${cands[alt].mins > c.mins ? mm(cands[alt].mins - c.mins) + ' min longer' : 'no slower'}.`, cta: 'Stay on lit streets' });
    }
    // nicer just beyond budget
    let nb = -1;
    cands.forEach((x, i) => { if (x.mins > c.mins + .5 && x.mins - c.mins <= Math.max(10, .35 * c.mins) && x.nice >= c.nice + 7 && x.dangerM <= c.dangerM + 40 && x.u > c.u) { if (nb < 0 || (x.nice - c.nice) / (x.mins - c.mins) > (cands[nb].nice - c.nice) / (cands[nb].mins - c.mins)) nb = i; } });
    if (nb >= 0 && !out.some(o => o.idx === nb)) { const x = cands[nb]; out.push({ kind: 'nicer', idx: nb, text: `For ${mm(x.mins - c.mins)} more min you could have a noticeably nicer walk: ${diffText(c, x)}.`, cta: `Take the nicer walk (+${mm(x.mins - c.mins)} min)` }); }
    if (ci !== 0 && c.mins - fastest.mins >= 1) out.push({ kind: 'info', idx: 0, text: `This is ${mm(c.mins - fastest.mins)} min longer than the fastest route (${mm(fastest.mins)} min). What you get for it: ${diffText(fastest, c)}.`, cta: 'Just take the fastest' });
    if (ci === 0 && nb < 0 && c.dangerM <= 50 && extra > 0) out.push({ kind: 'info', text: `The direct route is already the nicest option here. No detour within ${extra} min improves on it.` });
    if (ci === 0 && extra === 0 && nb < 0 && cands.length > 1 && c.dangerM <= 50) out.push({ kind: 'info', text: 'Longer options exist but none is meaningfully nicer than the direct route.' });
    return out;
  }

  /* ---------- loops ---------- */
  function findLoops(A, from, mins, opts) {
    opts = opts || {};
    const night = !!opts.night, L = mins * WALK;
    const [sx, sy] = A.toXY(from.lat, from.lon), s = nearestNode(A, sx, sy, 800);
    if (s < 0) return { error: 'No walkable streets found near you.' };
    const res = [];
    const used = new Uint8Array(A.m);
    for (let b = 0; b < 8; b++) {
      const th = b * 45 * rad; let r = L / 4.4, bestR = null;
      for (let it = 0; it < 3; it++) {
        const w = [-28, 28].map(off => { const a = th + off * rad; return bestScenicNode(A, sx + r * Math.sin(a), sy + r * Math.cos(a), Math.max(120, r * .38)); });
        if (w[0] < 0 || w[1] < 0 || w[0] === w[1] || w[0] === s || w[1] === s) break;
        used.fill(0);
        const P = { k: 2.5, kd: 9, night, used };
        const legs = []; let ok = true, seq = [s, w[0], w[1], s];
        for (let i = 0; i < 3; i++) { const p = astar(A, seq[i], seq[i + 1], P); if (!p) { ok = false; break; } for (const e of p.edges) used[e] = 1; legs.push(p); }
        if (!ok) break;
        const path = { nodes: legs[0].nodes.concat(legs[1].nodes.slice(1), legs[2].nodes.slice(1)), edges: legs[0].edges.concat(legs[1].edges, legs[2].edges) };
        const d = describe(A, path, night);
        const uniq = new Set(path.edges); let ul = 0; for (const e of uniq) ul += A.EL[e];
        d.overlap = 1 - ul / d.len;
        d.err = Math.abs(d.mins - mins) / mins;
        d.score = utility(d, night) - .5 * Math.max(0, d.err - .08) - .35 * d.overlap;
        d.bearing = b;
        if (!bestR || d.score > bestR.score) bestR = d;
        if (d.err < .1) break;
        r *= clamp(mins / d.mins, .55, 1.7);
      }
      if (bestR && bestR.err < .35) res.push(bestR);
    }
    if (!res.length) return { error: 'Could not build a loop from here. Try a different length.' };
    res.sort((a, b) => b.score - a.score);
    const pick = [];
    for (const r of res) { if (pick.every(p => { const d = Math.abs(p.bearing - r.bearing); return Math.min(d, 8 - d) >= 2; })) pick.push(r); if (pick.length === 3) break; }
    const dir = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    pick.forEach((p, i) => { p.label = i === 0 ? 'Best loop' : 'Loop ' + dir[p.bearing]; p.extra = 0; });
    const c = pick[0], t = [], fmt = opts.fmt || (m => Math.round(m / 10) * 10 + ' m');
    if (c.dangerM > 50) t.push({ kind: 'warn', text: `Heads up: about ${fmt(c.dangerM)} of this loop touches ${c.danger.map(z => z.name).join(' and ')}, where reported crime is higher.` });
    return { cands: pick, chosen: 0, tradeoffs: t };
  }

  /* ---------- transit ---------- */
  const normName = s => (s || '').toLowerCase().replace(/\b(station|underground|subway|metro)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  function parseTransit(json) {
    const nodes = new Map(); for (const e of json.elements) if (e.type === 'node') nodes.set(e.id, e);
    const stations = [], lines = [], seenLine = new Set();
    const stationFor = (nd) => {
      const nm = ((nd.tags && nd.tags.name) || '').replace(/\s+(Platforms?|Track|Gleis)\s+[\w&, ]+$/i, '').replace(/\s*\((north|south|east|west)bound\)$/i, ''), nn = normName(nm);
      for (let i = 0; i < stations.length; i++) { const s = stations[i], d = dist(s.lat, s.lon, nd.lat, nd.lon); if (d < 60 || (nn && s.nn === nn && d < 350)) { if (!s.n && nm) { s.n = nm; s.nn = nn; } return i; } }
      stations.push({ n: nm, nn, lat: +nd.lat.toFixed(5), lon: +nd.lon.toFixed(5) }); return stations.length - 1;
    };
    for (const r of json.elements) {
      if (r.type !== 'relation' || !r.members) continue;
      const t = r.tags || {};
      const mem = r.members.filter(m => m.type === 'node' && nodes.has(m.ref));
      let stops = mem.filter(m => /^stop/.test(m.role));
      if (stops.length < 2) stops = mem.filter(m => m.role === '' || m.role === 'station');
      if (stops.length < 2) stops = mem.filter(m => /^platform/.test(m.role));
      if (stops.length < 2) continue;
      const seq = []; for (const m of stops) { const si = stationFor(nodes.get(m.ref)); if (seq[seq.length - 1] !== si) seq.push(si); }
      if (seq.length < 2) continue;
      const ref = /^DLR\b/.test(t.name || '') ? 'DLR' : (t.ref || t.name || '?');
      const k1 = ref + '|' + seq.join(','), k2 = ref + '|' + seq.slice().reverse().join(',');
      if (seenLine.has(k1) || seenLine.has(k2)) continue; seenLine.add(k1);
      lines.push({ ref, name: t.name || ref, color: t.colour || t.color || '', mode: t.route, stops: seq });
    }
    return { stations: stations.map(s => ({ n: s.n || 'Station', lat: s.lat, lon: s.lon })), lines };
  }
  function prepTransit(net) {
    if (net._prep) return net;
    const off = [0]; for (const l of net.lines) off.push(off[off.length - 1] + l.stops.length);
    const atStation = net.stations.map(() => []);
    net.lines.forEach((l, li) => l.stops.forEach((s, p) => atStation[s].push(off[li] + p)));
    // nearby stations for transfers
    const near = net.stations.map(() => []);
    for (let i = 0; i < net.stations.length; i++) for (let j = i + 1; j < net.stations.length; j++) {
      const a = net.stations[i], b = net.stations[j];
      if (Math.abs(a.lat - b.lat) > .004) continue;
      const d = dist(a.lat, a.lon, b.lat, b.lon); if (d < 260) { near[i].push([j, d]); near[j].push([i, d]); }
    }
    net._prep = { off, atStation, near, total: off[off.length - 1] };
    return net;
  }
  const SPEED = { subway: 640, light_rail: 470, monorail: 420, tram: 300 }; // m/min incl. accel
  function transitRoute(net, from, to, opts) {
    opts = opts || {};
    prepTransit(net);
    const { off, atStation, near, total } = net._prep, St = net.stations, maxWalk = opts.maxWalk || 1600;
    const lineOf = id => { let lo = 0, hi = net.lines.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (off[m] <= id) lo = m; else hi = m - 1; } return lo; };
    const D = new Float64Array(total).fill(Infinity), prev = new Int32Array(total).fill(-1), how = new Uint8Array(total); // how: 0 board,1 ride,2 transfer
    const startSt = new Int32Array(total).fill(-1);
    const todo = [];
    St.forEach((s, si) => { const d = dist(from.lat, from.lon, s.lat, s.lon) * 1.3; if (d <= maxWalk) for (const id of atStation[si]) { const c = d / WALK + 4; if (c < D[id]) { D[id] = c; todo.push(id); } } });
    if (!todo.length) return null;
    const endCost = St.map(s => { const d = dist(to.lat, to.lon, s.lat, s.lon) * 1.3; return d <= maxWalk ? d / WALK : Infinity; });
    const done = new Uint8Array(total); let best = -1, bestT = Infinity;
    for (;;) {
      let u = -1, du = Infinity; for (let i = 0; i < total; i++) if (!done[i] && D[i] < du) { du = D[i]; u = i; }
      if (u < 0 || du >= bestT) break; done[u] = 1;
      const li = lineOf(u), l = net.lines[li], p = u - off[li], si = l.stops[p];
      if (du + endCost[si] < bestT && how[u] === 1) { bestT = du + endCost[si]; best = u; }
      for (const q of [p - 1, p + 1]) if (q >= 0 && q < l.stops.length) {
        const a = St[si], b = St[l.stops[q]], c = dist(a.lat, a.lon, b.lat, b.lon) * 1.1 / (SPEED[l.mode] || 450) + .45, v = off[li] + q;
        if (du + c < D[v]) { D[v] = du + c; prev[v] = u; how[v] = 1; }
      }
      const xfer = (sj, dw) => { for (const v of atStation[sj]) { if (lineOf(v) === li) continue; if (net.lines[lineOf(v)].ref === l.ref && sj === si) { if (du + .1 < D[v]) { D[v] = du + .1; prev[v] = u; how[v] = 3; } continue; } const c = 5 + dw * 1.3 / WALK; if (du + c < D[v]) { D[v] = du + c; prev[v] = u; how[v] = 2; } } };
      xfer(si, 0); for (const [sj, dw] of near[si]) xfer(sj, dw);
    }
    if (best < 0) return null;
    const chain = []; for (let u = best; u !== -1; u = prev[u]) chain.push(u); chain.reverse();
    const legs = []; let ride = null;
    const stOf = id => { const li = lineOf(id); return net.lines[li].stops[id - off[li]]; };
    const first = St[stOf(chain[0])];
    legs.push({ type: 'walk', from: { lat: from.lat, lon: from.lon, n: 'Start' }, to: { lat: first.lat, lon: first.lon, n: first.n }, mins: dist(from.lat, from.lon, first.lat, first.lon) * 1.3 / WALK });
    for (let i = 0; i < chain.length; i++) {
      const u = chain[i], li = lineOf(u), l = net.lines[li], s = St[stOf(u)];
      if (i === 0 || how[u] === 2) {
        if (ride && how[u] === 2) { const ps = St[stOf(chain[i - 1])]; if (stOf(chain[i - 1]) !== stOf(u)) legs.push({ type: 'walk', transfer: true, from: { lat: ps.lat, lon: ps.lon, n: ps.n }, to: { lat: s.lat, lon: s.lon, n: s.n }, mins: dist(ps.lat, ps.lon, s.lat, s.lon) * 1.3 / WALK }); }
        ride = { type: 'ride', ref: l.ref, name: l.name, color: l.color, mode: l.mode, from: s.n, to: s.n, stops: 0, coords: [[s.lat, s.lon]], t0: D[u], mins: 0, wait: i === 0 ? 4 : 5, li, dir: 0 };
        legs.push(ride);
      } else if (how[u] === 3) { ride.li = li; }
      else { ride.to = s.n; ride.stops++; ride.coords.push([s.lat, s.lon]); ride.mins = D[u] - ride.t0; ride.dir = (u - off[li]) - (chain[i - 1] - off[lineOf(chain[i - 1])]) ; ride.li = li; }
    }
    const rides = legs.filter(x => x.type === 'ride' && x.stops > 0);
    for (const r of rides) { const l = net.lines[r.li]; r.toward = St[r.dir >= 0 ? l.stops[l.stops.length - 1] : l.stops[0]].n; }
    const last = St[stOf(best)];
    const out = legs.filter(x => x.type !== 'ride' || x.stops > 0);
    out.push({ type: 'walk', from: { lat: last.lat, lon: last.lon, n: last.n }, to: { lat: to.lat, lon: to.lon, n: 'Destination' }, mins: endCost[stOf(best)] });
    return { mins: bestT, legs: out, rides: rides.length, walkMins: out.filter(x => x.type === 'walk').reduce((a, b) => a + b.mins, 0) };
  }
  function transitQuery(b) { const B = b.map(v => v.toFixed(4)).join(','); return `[out:json][timeout:90];relation[route~"^(subway|light_rail|monorail)$"](${B});out body;node(r);out body;`; }

  /* ---------- prebaked tiles ---------- */
  function tilesToJson(tiles) {
    const seen = new Set(), elements = [], ids = new Map(); let bLat = null, bLon = 0, next = 1;
    const geom = (g, wantIds) => {
      const out = [], nd = wantIds ? [] : null; let y = 0, x = 0;
      for (let i = 0; i < g.length; i += 2) {
        if (i === 0) { y = g[0]; x = g[1]; } else { y += g[i]; x += g[i + 1]; }
        out.push({ lat: y / 1e6, lon: x / 1e6 });
        if (nd) { if (bLat === null) { bLat = y; bLon = x; } const k = (y - bLat + 4e6) * 16e6 + (x - bLon + 8e6); let id = ids.get(k); if (!id) { id = next++; ids.set(k, id); } nd.push(id); }
      }
      return [out, nd];
    };
    for (const t of tiles) {
      if (!t) continue;
      for (const w of t.w) { if (seen.has(w.i)) continue; seen.add(w.i); const [g, nd] = geom(w.g, !!w.t.highway); elements.push({ type: 'way', id: w.i, tags: w.t, geometry: g, nodes: nd || [] }); }
      for (const r of t.r) { if (seen.has(r.i)) continue; seen.add(r.i); elements.push({ type: 'relation', id: r.i, tags: r.t, members: r.p.map(p => ({ type: 'way', geometry: geom(p, false)[0] })) }); }
      for (const n of t.n) { const k = 'n' + n.i; if (seen.has(k)) continue; seen.add(k); elements.push({ type: 'node', id: n.i, tags: n.t, lat: n.g[0] / 1e6, lon: n.g[1] / 1e6 }); }
    }
    return { elements };
  }
  // tiles overlapping bbox; with a corridor {a, b, m} only those within m metres of the segment a-b
  function tileKeys(bbox, ts, cor) {
    const out = [];
    for (let ty = Math.floor(bbox[0] / ts); ty <= Math.floor(bbox[2] / ts); ty++) for (let tx = Math.floor(bbox[1] / ts); tx <= Math.floor(bbox[3] / ts); tx++) {
      if (cor) {
        const cl = (ty + .5) * ts, co = (tx + .5) * ts, kx = 111320 * Math.cos(cl * rad), ky = 110540;
        const ax = (cor.a.lon - co) * kx, ay = (cor.a.lat - cl) * ky, bx = (cor.b.lon - co) * kx, by = (cor.b.lat - cl) * ky;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 ? clamp(-(ax * dx + ay * dy) / L2, 0, 1) : 0;
        if (Math.hypot(ax + t * dx, ay + t * dy) > cor.m + ts * Math.hypot(kx, ky) / 2) continue;
      }
      out.push(ty + '_' + tx);
    }
    return out;
  }

  function bboxFor(points, marginM) {
    let S = 90, N = -90, W = 180, E = -180;
    for (const p of points) { S = Math.min(S, p.lat); N = Math.max(N, p.lat); W = Math.min(W, p.lon); E = Math.max(E, p.lon); }
    const dLat = marginM / 110540, dLon = marginM / (111320 * Math.cos((S + N) / 2 * rad));
    return [S - dLat, W - dLon, N + dLat, E + dLon];
  }
  const within = (inner, outer) => inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];

  return { dist, overpass, areaQuery, buildArea, planWalk, findLoops, parseTransit, transitRoute, tilesToJson, tileKeys, transitQuery, bboxFor, within, nearestNode, WALK };
});
