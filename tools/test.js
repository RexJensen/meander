const C = require('../core.js'), CITIES = require('../data.js'), fs = require('fs');
(async () => {
  const [cid, flat, flon, tlat, tlon, extra] = process.argv.slice(2);
  const city = CITIES.find(c => c.id === cid);
  const from = { lat: +flat, lon: +flon }, to = tlat === 'loop' ? null : { lat: +tlat, lon: +tlon };
  const d = to ? C.dist(from.lat, from.lon, to.lat, to.lon) : 0;
  const bbox = to ? C.bboxFor([from, to], Math.max(400, d * .3)) : C.bboxFor([from], (+tlon) * 80 / 4.4 * 1.5 + 250);
  const cache = `/tmp/claude-501/ov_${bbox.map(v => v.toFixed(3)).join('_')}.json`;
  let j, t = Date.now();
  if (fs.existsSync(cache)) j = JSON.parse(fs.readFileSync(cache)); else { j = await C.overpass(C.areaQuery(bbox)); fs.writeFileSync(cache, JSON.stringify(j)); }
  console.log('fetch', Date.now() - t, 'ms', j.elements.length, 'elements', (JSON.stringify(j).length / 1e6).toFixed(1), 'MB');
  t = Date.now(); const A = C.buildArea(j, bbox, city); console.log('build', Date.now() - t, 'ms nodes', A.n, 'edges', A.m, 'grid', A.gw, A.gh);
  t = Date.now();
  const res = to ? C.planWalk(A, from, to, { extraMin: +extra || 0 }) : C.findLoops(A, from, +tlon, {});
  console.log('plan', Date.now() - t, 'ms');
  if (res.error) return console.log(res.error);
  res.cands.forEach((c, i) => console.log(i === res.chosen ? '*' : ' ', c.label, c.mins.toFixed(1) + 'min', Math.round(c.len) + 'm', 'nice', c.nice, 'park', c.pPark, 'water', c.pWater, 'major', c.pMajor, 'danger', Math.round(c.dangerM), c.danger.map(z => z.name).join('/'), '|', c.parks.map(p => p.name).join(', '), '|', c.highlights.map(h => h.name).join('; ')));
  res.tradeoffs.forEach(t => console.log(' >', t.kind, t.text));
  console.log(res.cands[res.chosen].steps.slice(0, 14).map(s => `   ${s.text} (${s.m} m)`).join('\n'));
})().catch(e => console.error('ERR', e));
