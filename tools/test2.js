// offline test using baked tiles: node test2.js city flat flon tlat tlon extra [night]  | city flat flon loop mins
const C = require('../core.js'), CITIES = require('../data.js'), fs = require('fs'), path = require('path');
const [cid, flat, flon, tlat, tlon, extra, night] = process.argv.slice(2);
const city = CITIES.find(c => c.id === cid), root = path.join(__dirname, '..');
const idx = JSON.parse(fs.readFileSync(`${root}/tiles/${cid}/index.json`));
const from = { lat: +flat, lon: +flon }, to = tlat === 'loop' ? null : { lat: +tlat, lon: +tlon };
const d = to ? C.dist(from.lat, from.lon, to.lat, to.lon) : 0;
const bbox = to ? C.bboxFor([from, to], Math.max(450, d * .3 + (+extra || 0) * 35)) : C.bboxFor([from], (+tlon) * 80 / 4.4 * 1.5 + 300);
let t = Date.now();
const keys = C.tileKeys(bbox, idx.ts), ts = keys.map(k => idx.tiles.includes(k) ? JSON.parse(fs.readFileSync(`${root}/tiles/${cid}/${k}.json`)) : null);
const f = v => Math.floor(v / idx.ts) * idx.ts, ab = [f(bbox[0]), f(bbox[1]), f(bbox[2]) + idx.ts, f(bbox[3]) + idx.ts];
const A = C.buildArea(C.tilesToJson(ts), ab, city);
console.log('tiles', keys.length, 'build', Date.now() - t, 'ms nodes', A.n, 'edges', A.m, 'grid', A.gw, A.gh); t = Date.now();
const res = to ? C.planWalk(A, from, to, { extraMin: +extra || 0, night: !!night }) : C.findLoops(A, from, +tlon, {});
console.log('plan', Date.now() - t, 'ms');
if (res.error) { console.log(res.error); process.exit(); }
res.cands.forEach((c, i) => console.log(i === res.chosen ? '*' : ' ', c.label, c.mins.toFixed(1) + 'min', Math.round(c.len) + 'm', 'nice', c.nice, 'park', c.pPark, 'water', c.pWater, 'major', c.pMajor, 'danger', Math.round(c.dangerM), c.danger.map(z => z.name).join('/'), c.overlap != null ? 'overlap ' + c.overlap.toFixed(2) : '', '|', c.parks.map(p => p.name).join(', '), '|', c.highlights.map(h => h.name).join('; ')));
res.tradeoffs.forEach(t => console.log(' >', t.kind, t.text));
console.log(res.cands[res.chosen].steps.slice(0, 12).map(s => `   ${s.text} (${s.m} m)`).join('\n'));
if (to) { const net = JSON.parse(fs.readFileSync(`${root}/transit/${cid}.json`)); const tr = C.transitRoute(net, from, to); if (tr) console.log('TRANSIT', tr.mins.toFixed(1), tr.legs.map(l => l.type === 'walk' ? `walk ${l.mins.toFixed(1)} to ${l.to.n}` : `[${l.ref}] ${l.from}->${l.to} ${l.stops} stops ${l.mins.toFixed(1)}m toward ${l.toward}`).join(' | ')); else console.log('no transit'); }
