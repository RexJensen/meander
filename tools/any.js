const C = require('../core.js');
(async () => {
  for (const [name, a, b] of [['Paris', { lat: 48.8584, lon: 2.2945 }, { lat: 48.8606, lon: 2.3376 }], ['San Francisco', { lat: 37.7955, lon: -122.3937 }, { lat: 37.8080, lon: -122.4177 }]]) {
    const d = C.dist(a.lat, a.lon, b.lat, b.lon), bbox = C.bboxFor([a, b], Math.min(1300, Math.max(450, d * .25 + 300)));
    let t = Date.now();
    try {
      const j = await C.overpass(C.areaQuery(bbox));
      console.log(name, 'fetch', Date.now() - t, 'ms', j.elements.length, 'elements');
      const A = C.buildArea(j, bbox, {}), r = C.planWalk(A, a, b, { extraMin: 10 });
      r.cands.forEach((c, i) => console.log(i === r.chosen ? ' *' : '  ', c.label, c.mins.toFixed(0) + 'min nice', c.nice, 'park', c.pPark, 'water', c.pWater, '|', c.highlights.map(h => h.name).join('; ')));
      r.tradeoffs.forEach(x => console.log('   >', x.text));
      t = Date.now(); const net = C.parseTransit(await C.overpass(C.transitQuery(C.bboxFor([a, b], 6000)), { timeout: 25000 }));
      const tr = C.transitRoute(net, a, b); console.log('  transit fetch', Date.now() - t, 'ms lines', net.lines.length, tr ? tr.legs.filter(l => l.type === 'ride').map(l => `[${l.ref}] ${l.from}->${l.to}`).join(' ') : 'none useful');
    } catch (e) { console.log(name, 'FAILED after', Date.now() - t, 'ms', e.message); }
  }
})();
