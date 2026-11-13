/* Bake compact walking tiles + transit network for one city from an .osm.pbf extract.
   usage: node bake.js <cityId> <file.osm.pbf> <outDir> <S,W,N,E coverage> <parserModuleDir> */
const fs = require('fs'), path = require('path');
const [cityId, pbf, outDir, covStr, modDir] = process.argv.slice(2);
const parseOSM = require(path.join(modDir, 'node_modules/osm-pbf-parser'));
const through = require(path.join(modDir, 'node_modules/through2'));
const Core = require('../core.js');
const cov = covStr.split(',').map(Number), [S, W, N, E] = cov;
const TS = 0.02;
const HW_SKIP = /^(motorway|motorway_link|construction|proposed|bus_guideway|raceway|platform|elevator|rest_area|services|corridor)$/;
const KEEP = ['highway', 'name', 'foot', 'access', 'service', 'sidewalk', 'footway', 'lit', 'tunnel', 'bridge', 'indoor', 'level', 'segregated', 'leisure', 'landuse', 'natural', 'waterway', 'tourism', 'historic', 'amenity'];
function wantWay(t) {
  if (t.highway) return !HW_SKIP.test(t.highway);
  return /^(park|garden|nature_reserve|common)$/.test(t.leisure || '') || /^(forest|meadow|grass|village_green|recreation_ground|cemetery|industrial|railway)$/.test(t.landuse || '') ||
    /^(wood|scrub|beach|tree_row|water|coastline)$/.test(t.natural || '') || /^(river|canal|stream|riverbank|dock)$/.test(t.waterway || '') ||
    /^(attraction|museum|gallery|artwork|viewpoint)$/.test(t.tourism || '') || /^(monument|castle|ruins|fort|city_gate|ship|memorial|building|church)$/.test(t.historic || '');
}
const wantNode = t => /^(attraction|museum|gallery|artwork|viewpoint)$/.test(t.tourism || '') || /^(monument|castle|ruins|fort|city_gate|ship)$/.test(t.historic || '') || t.amenity === 'fountain';
function slim(t) { const o = {}; for (const k of KEEP) if (t[k] != null) o[k] = t[k]; if (t.wikidata || t.wikipedia) o.wikidata = '1'; return o; }
function scan(onItem) {
  return new Promise((res, rej) => fs.createReadStream(pbf).pipe(parseOSM()).pipe(through.obj((items, enc, next) => { for (const it of items) onItem(it); next(); })).on('finish', res).on('error', rej).resume());
}
(async () => {
  let t0 = Date.now();
  // pass A: relations
  const parkRel = [], waterWays = new Set(), relWays = new Set(), transitRel = [], stopNodes = new Set();
  await scan(it => {
    if (it.type !== 'relation') return; const t = it.tags || {};
    if (/^(subway|light_rail|monorail)$/.test(t.route || '')) { transitRel.push(it); for (const m of it.members) if (m.type === 'node') stopNodes.add(m.id); }
    else if (t.type === 'multipolygon' || t.type === 'boundary') {
      if (/^(park|garden|nature_reserve)$/.test(t.leisure || '')) { parkRel.push(it); for (const m of it.members) if (m.type === 'way') relWays.add(m.id); }
      else if (t.natural === 'water') for (const m of it.members) if (m.type === 'way') waterWays.add(m.id);
    }
  });
  console.log(cityId, 'pass A', Date.now() - t0, 'ms; parks', parkRel.length, 'waterWays', waterWays.size, 'transit', transitRel.length);
  // pass B: nodes + ways
  t0 = Date.now();
  let cap = 1 << 20, n = 0, ids = new Float64Array(cap), la = new Int32Array(cap), lo = new Int32Array(cap), sorted = true;
  const M = 0.03; // node margin outside coverage
  const stopInfo = new Map(), poiNodes = [], ways = [], relGeom = new Map();
  const find = id => { let a = 0, b = n - 1; while (a <= b) { const m = (a + b) >> 1; if (ids[m] === id) return m; if (ids[m] < id) a = m + 1; else b = m - 1; } return -1; };
  await scan(it => {
    if (it.type === 'node') {
      if (stopNodes.has(it.id)) stopInfo.set(it.id, { type: 'node', id: it.id, lat: it.lat, lon: it.lon, tags: it.tags && it.tags.name ? { name: it.tags.name } : {} });
      if (it.lat < S - M || it.lat > N + M || it.lon < W - M || it.lon > E + M) return;
      if (n === cap) { cap *= 2; const a = new Float64Array(cap); a.set(ids); ids = a; const b = new Int32Array(cap); b.set(la); la = b; const c = new Int32Array(cap); c.set(lo); lo = c; }
      if (n && it.id < ids[n - 1]) sorted = false;
      ids[n] = it.id; la[n] = Math.round(it.lat * 1e6); lo[n] = Math.round(it.lon * 1e6); n++;
      const t = it.tags;
      if (t && wantNode(t) && it.lat >= S && it.lat <= N && it.lon >= W && it.lon <= E) poiNodes.push({ i: it.id, t: slim(t), g: [la[n - 1], lo[n - 1]] });
    } else if (it.type === 'way') {
      if (!sorted) throw new Error('nodes not sorted');
      const t = it.tags || {}, isW = waterWays.has(it.id), isR = relWays.has(it.id);
      if (!isW && !isR && !wantWay(t)) return;
      const g = []; let any = false;
      for (const r of it.refs) { const k = find(r); if (k < 0) { g.push(null); continue; } any = true; g.push(la[k], lo[k]); }
      if (!any) return;
      if (isR) relGeom.set(it.id, g);
      if (wantWay(t)) ways.push({ i: it.id, t: slim(t), g });
      else if (isW) ways.push({ i: it.id, t: { natural: 'water' }, g });
    }
  });
  console.log(cityId, 'pass B', Date.now() - t0, 'ms; nodes', n, 'ways', ways.length, 'pois', poiNodes.length);
  // tiles
  const tiles = new Map();
  const add = (key, kind, el) => { let t = tiles.get(key); if (!t) tiles.set(key, t = { w: [], r: [], n: [] }); t[kind].push(el); };
  const ty0 = Math.floor(S / TS), ty1 = Math.floor(N / TS), tx0 = Math.floor(W / TS), tx1 = Math.floor(E / TS);
  const span = g => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (let i = 0; i < g.length; i++) { if (g[i] === null) continue; const y = g[i], x = g[++i]; if (y < a) a = y; if (y > b) b = y; if (x < c) c = x; if (x > d) d = x; } return [a / 1e6, c / 1e6, b / 1e6, d / 1e6]; };
  const enc = g => { // split at nulls, delta-encode
    const parts = []; let cur = null, py = 0, px = 0;
    for (let i = 0; i < g.length; i++) { if (g[i] === null) { cur = null; continue; } const y = g[i], x = g[++i]; if (!cur) { cur = [y, x]; parts.push(cur); } else cur.push(y - py, x - px); py = y; px = x; }
    return parts.filter(p => p.length >= 4);
  };
  const place = (kind, el, bb) => {
    for (let ty = Math.max(ty0, Math.floor(bb[0] / TS)); ty <= Math.min(ty1, Math.floor(bb[2] / TS)); ty++)
      for (let tx = Math.max(tx0, Math.floor(bb[1] / TS)); tx <= Math.min(tx1, Math.floor(bb[3] / TS)); tx++) add(ty + '_' + tx, kind, el);
  };
  const spanP = p => { let y = p[0], x = p[1], a = y, b = y, c = x, d = x; for (let i = 2; i < p.length; i += 2) { y += p[i]; x += p[i + 1]; if (y < a) a = y; if (y > b) b = y; if (x < c) c = x; if (x > d) d = x; } return [a / 1e6, c / 1e6, b / 1e6, d / 1e6]; };
  const joined = g => { const o = []; for (let i = 0; i < g.length; i++) { if (g[i] === null) continue; o.push(g[i], g[++i]); } return o; };
  for (const w of ways) {
    const isLine = w.t.highway || w.t.natural === 'water' || w.t.natural === 'coastline' || w.t.waterway || w.t.natural === 'tree_row';
    if (isLine && !w.t.leisure) {
      const parts = enc(w.g);
      parts.forEach((p, pi) => place('w', { i: parts.length > 1 ? w.i + '_' + pi : w.i, t: w.t, g: p }, spanP(p)));
    } else { const e = enc(joined(w.g)); if (e.length) place('w', { i: w.i, t: w.t, g: e[0] }, spanP(e[0])); }
  }
  for (const r of parkRel) {
    const ps = []; let bb = [90, 180, -90, -180];
    for (const m of r.members) { if (m.type !== 'way') continue; const g = relGeom.get(m.id); if (!g) continue; const e = enc(joined(g)); if (!e.length) continue; ps.push(e[0]); const s = spanP(e[0]); bb = [Math.min(bb[0], s[0]), Math.min(bb[1], s[1]), Math.max(bb[2], s[2]), Math.max(bb[3], s[3])]; }
    if (ps.length) place('r', { i: 'r' + r.id, t: slim(r.tags), p: ps }, bb);
  }
  for (const p of poiNodes) add(Math.floor(p.g[0] / 1e6 / TS) + '_' + Math.floor(p.g[1] / 1e6 / TS), 'n', p);
  const dir = path.join(outDir, 'tiles', cityId); fs.mkdirSync(dir, { recursive: true });
  let bytes = 0; const index = [];
  for (const [k, t] of tiles) { const s = JSON.stringify(t); bytes += s.length; fs.writeFileSync(path.join(dir, k + '.json'), s); index.push(k); }
  console.log(cityId, 'tiles', tiles.size, (bytes / 1e6).toFixed(1), 'MB');
  // transit
  const tj = { elements: [...stopInfo.values()].concat(transitRel.map(r => ({ type: 'relation', id: r.id, tags: r.tags, members: r.members.map(m => ({ type: m.type, ref: m.id, role: m.role })) }))) };
  const net = Core.parseTransit(tj);
  fs.mkdirSync(path.join(outDir, 'transit'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'transit', cityId + '.json'), JSON.stringify(net));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ cov, ts: TS, tiles: index }));
  console.log(cityId, 'transit stations', net.stations.length, 'lines', net.lines.length, [...new Set(net.lines.map(l => l.ref))].join(' '));
})().catch(e => { console.error(e); process.exit(1); });
