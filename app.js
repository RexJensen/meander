/* Meander UI */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hr = new Date().getHours();
  const st = { city: null, from: null, to: null, mode: 'go', extra: 10, loop: 30, night: hr >= 19 || hr < 6, gps: null, cards: [], sel: 0, notes: [], zonesOn: true, nav: null, fromIsGps: false };
  const fmtMin = m => { m = Math.max(1, Math.round(m)); return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60 ? (m % 60) + ' min' : '') : m + ' min'; };
  const fmtDist = m => useMiles() ? (m < 250 ? Math.max(10, Math.round(m * 3.28084 / 50) * 50) + ' ft' : (m / 1609.34).toFixed(1) + ' mi') : (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.max(10, Math.round(m / 10) * 10) + ' m');
  const useMiles = () => !st.city || st.city.id !== 'london' ? (st.city ? true : /^en-US/.test(navigator.language || '')) : false;
  const inBox = (p, b) => p.lat >= b[0] && p.lat <= b[2] && p.lon >= b[1] && p.lon <= b[3];
  const cityAt = p => CITIES.find(c => inBox(p, c.bbox)) || null;

  /* ---------- map ---------- */
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([40.758, -73.9855], 14);
  map.attributionControl.setPrefix('');
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' }).addTo(map);
  const lZones = L.layerGroup().addTo(map), lSpots = L.layerGroup(), lRoute = L.layerGroup().addTo(map), lPins = L.layerGroup().addTo(map), lMe = L.layerGroup().addTo(map);
  const icon = (cls, s) => L.divIcon({ className: '', html: `<div class="${cls}"></div>`, iconSize: [s, s], iconAnchor: [s / 2, cls === 'pin' ? s : s / 2] });

  function drawCity() {
    lZones.clearLayers(); lSpots.clearLayers();
    for (const c of CITIES) {
      for (const z of c.zones) L.circle([z.lat, z.lon], { radius: z.r, color: '#c2362b', weight: 1.5, dashArray: '5 5', fillColor: '#c2362b', fillOpacity: .12 + .1 * z.sev }).addTo(lZones)
        .bindPopup(`<b>${esc(z.n)}</b><br>Higher reported crime than the rest of the city.${z.t ? ' ' + esc(z.t) + '.' : ''}<br><small>Approximate area. Conditions vary by block and time of day.</small>`);
      for (const s of c.spots) { const p = s.pts ? s.pts[Math.floor(s.pts.length / 2)] : [s.lat, s.lon]; const m = L.marker(p, { icon: icon('spot', 14) }).addTo(lSpots); m.bindPopup(() => popupFor({ lat: p[0], lon: p[1], label: s.n }, s.t)); }
    }
  }
  function popupFor(p, sub) {
    const d = document.createElement('div');
    d.innerHTML = `<b>${esc(p.label || 'Dropped pin')}</b>${sub ? '<br>' + esc(sub) : ''}<button data-a="to">Walk here</button><button class="alt" data-a="from">Start from here</button>`;
    d.onclick = e => { const a = e.target.dataset.a; if (!a) return; map.closePopup(); if (a === 'to') { setTo(p); if (st.mode !== 'go') setMode('go'); go(); } else { setFrom(p, false); } };
    return d;
  }
  map.on('zoomend', () => { if (map.getZoom() >= 13) map.addLayer(lSpots); else map.removeLayer(lSpots); });
  map.on('click', e => { if (st.nav) return; const p = { lat: e.latlng.lat, lon: e.latlng.lng, label: 'Dropped pin' }; L.popup().setLatLng(e.latlng).setContent(popupFor(p)).openOn(map); });

  /* ---------- helpers ---------- */
  let toastT; function toast(msg, ms) { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => t.style.display = 'none', ms || 4500); }
  function busy(msg) { $('#busy').style.display = msg ? 'flex' : 'none'; if (msg) $('#busyText').textContent = msg; $('#goBtn').disabled = !!msg; }
  function setCity(c) { st.city = c; $('#cityName').textContent = c ? c.name.replace(/ \(.*/, '') : 'Anywhere'; try { localStorage.setItem('meander.city', c ? c.id : ''); } catch (e) { } }
  function pins() {
    lPins.clearLayers();
    if (st.from && !(st.fromIsGps && st.gps)) L.marker([st.from.lat, st.from.lon], { icon: icon('pin a', 16) }).addTo(lPins);
    if (st.to && st.mode === 'go') L.marker([st.to.lat, st.to.lon], { icon: icon('pin', 22) }).addTo(lPins);
  }
  function setFrom(p, isGps) { st.from = p; st.fromIsGps = !!isGps; $('#from').value = isGps ? '' : (p.label || ''); $('#from').placeholder = isGps ? 'My location' : 'Starting point'; const c = cityAt(p); if (c !== st.city) setCity(c); pins(); }
  function setTo(p) { st.to = p; $('#to').value = p ? (p.label || 'Dropped pin') : ''; pins(); }
  function setMode(m) {
    st.mode = m; $('#modeGo').setAttribute('aria-pressed', m === 'go'); $('#modeLoop').setAttribute('aria-pressed', m === 'loop');
    $('#toField').hidden = m !== 'go'; $('#goOpts').hidden = m !== 'go'; $('#loopOpts').hidden = m !== 'loop';
    $('#goBtn').textContent = m === 'go' ? 'Find the nicest way' : 'Find me a scenic walk'; pins();
  }
  function chips(el, vals, cur, fmt, on) {
    el.innerHTML = ''; vals.forEach(v => { const b = document.createElement('button'); b.textContent = fmt(v); b.setAttribute('aria-pressed', v === cur); b.onclick = () => { on(v); chips(el, vals, v, fmt, on); }; el.appendChild(b); });
  }
  function setNight(n) {
    st.night = n; document.documentElement.dataset.night = n ? '1' : '0'; $('#fabNight').setAttribute('aria-pressed', n);
    document.querySelector('meta[name=theme-color]').content = n ? '#0f1512' : '#f4f6f1';
  }

  /* ---------- data loading ---------- */
  const tileIdx = {}, tileCache = new Map(), areas = [], nets = {};
  async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }
  async function cityIndex(c) { if (!(c.id in tileIdx)) { try { const j = await getJSON(`tiles/${c.id}/index.json`); j.set = new Set(j.tiles); tileIdx[c.id] = j; } catch (e) { tileIdx[c.id] = null; } } return tileIdx[c.id]; }
  async function getArea(bbox, pts, cor) {
    for (const a of areas) if (!a.cor && !cor && Core.within(bbox, a.bbox)) return a.A;
    for (const a of areas) if (cor && a.cor && a.cor.a.lat === cor.a.lat && a.cor.a.lon === cor.a.lon && a.cor.b.lat === cor.b.lat && a.cor.b.lon === cor.b.lon && a.cor.m >= cor.m) return a.A;
    const c = CITIES.find(c => pts.every(p => inBox(p, c.bbox))) || null;
    const cfg = c ? { zones: c.zones, spots: c.spots } : { zones: [].concat(...CITIES.map(c => c.zones)).filter(z => z.lat > bbox[0] - .1 && z.lat < bbox[2] + .1 && z.lon > bbox[1] - .1 && z.lon < bbox[3] + .1), spots: [] };
    let json = null, ab = bbox;
    const idx = c && await cityIndex(c);
    if (idx && Core.within(bbox, idx.cov)) {
      const keys = Core.tileKeys(bbox, idx.ts, cor);
      busy('Loading the neighbourhood…');
      const ts = await Promise.all(keys.map(k => { if (!idx.set.has(k)) return null; const id = c.id + '/' + k; if (!tileCache.has(id)) tileCache.set(id, getJSON(`tiles/${id}.json`).catch(() => null)); return tileCache.get(id); }));
      json = Core.tilesToJson(ts);
      const f = v => Math.floor(v / idx.ts) * idx.ts;
      ab = [f(bbox[0]), f(bbox[1]), f(bbox[2]) + idx.ts, f(bbox[3]) + idx.ts];
      if (tileCache.size > 60) { const it = tileCache.keys(); for (let i = 0; i < 20; i++) tileCache.delete(it.next().value); }
    } else {
      busy('Fetching live map data (can take up to a minute here)…');
      json = await Core.overpass(Core.areaQuery(bbox), { timeout: 90000 });
    }
    busy('Scoring every street…'); await new Promise(r => setTimeout(r, 30));
    const A = Core.buildArea(json, ab, cfg);
    areas.unshift({ bbox: ab, A, cor: json && idx && cor ? cor : null }); if (areas.length > 3) areas.pop();
    return A;
  }
  async function getNet(from, to) {
    const c = cityAt(from);
    if (c) { if (!(c.id in nets)) nets[c.id] = getJSON(`transit/${c.id}.json`).catch(() => null); return nets[c.id]; }
    if (!to || Core.dist(from.lat, from.lon, to.lat, to.lon) < 2000) return null;
    const key = from.lat.toFixed(1) + ',' + from.lon.toFixed(1);
    if (!(key in nets)) nets[key] = Core.overpass(Core.transitQuery(Core.bboxFor([from, to], 6000)), { timeout: 90000 }).then(Core.parseTransit).catch(() => null);
    return nets[key];
  }

  /* ---------- planning ---------- */
  let runId = 0;
  async function go() {
    if (!st.from) return toast('Set a starting point first: allow location, search, or tap the map.');
    if (st.mode === 'go' && !st.to) { $('#to').focus(); return toast('Where to? Search for a place or tap the map.'); }
    const my = ++runId; endNav();
    try {
      let cards = [], notes = [];
      if (st.mode === 'loop') {
        const bbox = Core.bboxFor([st.from], st.loop * Core.WALK / 4.4 * 1.5 + 300);
        const A = await getArea(bbox, [st.from]); if (my !== runId) return;
        busy('Looking for the loveliest loop…'); await new Promise(r => setTimeout(r, 30));
        const res = Core.findLoops(A, st.from, st.loop, { night: st.night, fmt: fmtDist });
        if (res.error) throw new Error(res.error);
        cards = res.cands; notes = res.tradeoffs; st.sel = 0;
      } else {
        const d = Core.dist(st.from.lat, st.from.lon, st.to.lat, st.to.lon);
        if (d < 40) throw new Error('You are already there.');
        const netP = getNet(st.from, st.to);
        let res = null;
        if (d <= 6000) {
          const mg = Math.min(1300, Math.max(450, d * .25 + st.extra * 30));
          const A = await getArea(Core.bboxFor([st.from, st.to], mg), [st.from, st.to], { a: st.from, b: st.to, m: mg }); if (my !== runId) return;
          busy('Comparing routes…'); await new Promise(r => setTimeout(r, 30));
          res = Core.planWalk(A, st.from, st.to, { extraMin: st.extra, night: st.night, fmt: fmtDist });
          if (res.error) throw new Error(res.error);
          cards = res.cands; notes = res.tradeoffs; st.sel = res.chosen;
        }
        const tname = (st.city && st.city.transitName) || 'train';
        const addTransit = (tr) => { // returns true if a train option was added
          if (!tr || !tr.rides) return false;
          const w = cards[st.sel], f = cards[0];
          if (tr.mins > f.mins - 6) return false;
          cards.push({ transit: tr, mins: tr.mins, label: tname });
          const best = tr.mins < f.mins * .65 || f.mins > 50;
          if (best) notes.unshift({ kind: 'transit', idx: cards.length - 1, text: `The ${tname} is the better call here: about ${fmtMin(tr.mins)} door to door against ${fmtMin(f.mins)} on foot.`, cta: `Show the ${tname} route` });
          else notes.push({ kind: 'transit', idx: cards.length - 1, text: `In a hurry? The ${tname} takes about ${fmtMin(tr.mins)} (${fmtMin(w.mins - tr.mins)} quicker than this walk).`, cta: `Show the ${tname} route` });
          return best && f.mins > 75;
        };
        const routeNet = net => net && net.lines.length ? Core.transitRoute(net, st.from, st.to) : null;
        if (res && !cityAt(st.from)) {
          // live rail data can take a while outside the featured cities: show the walk now, add the train when it lands
          netP.then(net => { if (my !== runId || st.cards !== cards) return; const before = cards.length; addTransit(routeNet(net)); if (cards.length > before) { render(false); toast('Found a train option for this trip.'); } });
        } else {
          busy(res ? 'Checking the trains…' : 'Checking the trains (live data can take a minute)…');
          const net = await netP; if (my !== runId) return;
          const tr = routeNet(net);
          if (!res) {
            if (!tr) throw new Error(`That is about ${fmtMin(d * 1.3 / Core.WALK)} on foot, which is too far to plan as a walk, and I could not find a rail line that helps. Try somewhere closer.`);
            cards = [{ transit: tr, mins: tr.mins, label: tname }]; st.sel = 0;
            notes = [{ kind: 'transit', text: `That is roughly ${fmtMin(d * 1.3 / Core.WALK)} on foot, so the ${tname} is the way to go. The walks at each end still take the nicest streets.` }];
          } else if (addTransit(tr)) st.sel = cards.length - 1;
        }
      }
      st.cards = cards; st.notes = notes;
      busy(null); collapseTop(true); render(true);
      if (cards[st.sel].transit) loadTransitLegs(cards[st.sel]);
    } catch (e) {
      if (my !== runId) return; busy(null); console.error(e);
      toast(/HTTP|fetch|abort|network|Failed/i.test(e.message || '') ? 'The map data servers are busy right now. Give it a few seconds and try again.' : e.message, 7000);
    }
  }
  async function loadTransitLegs(card) {
    const tr = card.transit; if (tr.loaded) return; tr.loaded = true;
    const ends = [tr.legs[0], tr.legs[tr.legs.length - 1]];
    for (const leg of ends) {
      if (leg.type !== 'walk' || Core.dist(leg.from.lat, leg.from.lon, leg.to.lat, leg.to.lon) < 60) continue;
      try {
        const d = Core.dist(leg.from.lat, leg.from.lon, leg.to.lat, leg.to.lon);
        const A = await getArea(Core.bboxFor([leg.from, leg.to], Math.max(350, d * .4)), [leg.from, leg.to]);
        const r = Core.planWalk(A, leg.from, leg.to, { extraMin: Math.min(st.extra, 4), night: st.night });
        if (!r.error) { leg.route = r.cands[r.chosen]; leg.mins = leg.route.mins; }
      } catch (e) { /* keep straight line */ }
    }
    busy(null);
    tr.mins = tr.legs.reduce((a, l) => a + l.mins + (l.wait || 0), 0); card.mins = tr.mins;
    if (st.cards[st.sel] === card) render(false);
  }

  /* ---------- rendering ---------- */
  const lineColor = l => { let c = l.color; if (c && /^#?[0-9a-f]{3,6}$/i.test(c)) return c[0] === '#' ? c : '#' + c; if (c && /^[a-z]+$/i.test(c)) return c; let h = 0; for (const ch of l.ref) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 60% 40%)`; };
  const textOn = c => { const m = /^#([0-9a-f]{6})$/i.exec(c); if (!m) return '#fff'; const n = parseInt(m[1], 16); return ((n >> 16) * .299 + ((n >> 8) & 255) * .587 + (n & 255) * .114) > 160 ? '#111' : '#fff'; };
  const word = n => n >= 75 ? 'Lovely' : n >= 55 ? 'Pleasant' : n >= 35 ? 'Decent' : 'Plain';
  function facts(c) {
    const f = [];
    if (c.dangerM > 50) f.push('⚠ ' + (c.danger[0] ? c.danger[0].name : 'higher-crime area'));
    if (c.pPark >= 10) f.push(c.pPark + '% park');
    if (c.pWater >= 10) f.push(c.pWater + '% waterside');
    if (f.length < 2 && c.pMajor >= 25) f.push(c.pMajor + '% busy roads');
    if (!f.length) f.push('quiet streets');
    return f.slice(0, 2).join(' · ');
  }
  function drawWalk(r, selected, dashed) {
    if (!selected) return L.polyline(r.coords, { color: st.night ? '#8b9a90' : '#6c7b88', weight: 5, opacity: .55 }).addTo(lRoute);
    L.polyline(r.coords, { color: '#fff', weight: 10, opacity: .9 }).addTo(lRoute);
    const main = L.polyline(r.coords, { color: st.night ? '#58c48f' : '#1b7a50', weight: 6, dashArray: dashed ? '1 10' : null }).addTo(lRoute);
    let run = null;
    r.flags.forEach((f, i) => { if (f) { if (!run || run.f !== f) { run = { f, pts: [r.coords[i]] }; (run.f === 1 ? L.polyline(run.pts, { color: '#d8382b', weight: 6 }) : L.polyline(run.pts, { color: '#e8a917', weight: 6, dashArray: '2 9' })).addTo(lRoute)._run = run; run.layerPts = run.pts; } run.pts.push(r.coords[i + 1]); } else run = null; });
    lRoute.eachLayer(l => { if (l._run) l.setLatLngs(l._run.pts); });
    return main;
  }
  function render(fit) {
    const cards = st.cards, sel = cards[st.sel];
    lRoute.clearLayers();
    let bounds = null;
    cards.forEach((c, i) => { if (i !== st.sel && !c.transit) drawWalk(c, false).on('click', () => { st.sel = i; render(false); }); });
    if (sel.transit) {
      const pts = [];
      for (const leg of sel.transit.legs) {
        if (leg.type === 'ride') { const col = lineColor(leg); L.polyline(leg.coords, { color: '#fff', weight: 9 }).addTo(lRoute); L.polyline(leg.coords, { color: col, weight: 6 }).addTo(lRoute); for (const p of [leg.coords[0], leg.coords[leg.coords.length - 1]]) L.marker(p, { icon: icon('stn', 12), interactive: false }).addTo(lRoute); pts.push(...leg.coords); }
        else if (leg.route) { drawWalk(leg.route, true); pts.push(...leg.route.coords); }
        else { const l = [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]]; L.polyline(l, { color: st.night ? '#58c48f' : '#1b7a50', weight: 5, dashArray: '2 9' }).addTo(lRoute); pts.push(...l); }
      }
      bounds = L.latLngBounds(pts);
    } else bounds = drawWalk(sel, true).getBounds();
    pins();
    // cards
    $('#cards').innerHTML = cards.map((c, i) => {
      if (c.transit) { const rides = c.transit.legs.filter(l => l.type === 'ride'); return `<button class="card" data-i="${i}" aria-pressed="${i === st.sel}"><div class="k">${esc(c.label)}</div><div class="t">${fmtMin(c.mins)}</div><div class="f" style="display:flex;gap:4px;margin:6px 0 4px">${rides.map(l => { const col = lineColor(l); return `<span class="badge" style="background:${col};color:${textOn(col)};height:20px;min-width:20px;font-size:11px">${esc(l.ref.slice(0, 12))}</span>`; }).join('')}</div><div class="f">${fmtMin(c.transit.walkMins)} walking</div></button>`; }
      return `<button class="card" data-i="${i}" aria-pressed="${i === st.sel}"><div class="k">${esc(c.label)}${c.dangerM > 50 ? ' <span class="tag warn">!</span>' : ''}</div><div class="t">${fmtMin(c.mins)} ${c.extra >= 1 ? `<small>+${Math.round(c.extra)}</small>` : ''}</div><div class="meter" title="Niceness ${c.nice}/100"><i style="width:${c.nice}%"></i></div><div class="f"><b>${word(c.nice)}</b></div><div class="f">${facts(c)}</div></button>`;
    }).join('');
    // detail
    let h = '';
    const noteHtml = n => `<div class="note ${n.kind}">${esc(n.text)}${n.cta && n.idx != null && n.idx !== st.sel ? `<br><button data-i="${n.idx}">${esc(n.cta)}</button>` : ''}</div>`;
    if (sel.transit) {
      h += st.notes.filter(n => n.kind === 'transit').map(noteHtml).join('');
      h += '<h3>The trip</h3>';
      for (const leg of sel.transit.legs) {
        if (leg.type === 'walk') { if (leg.mins < .7) continue; h += `<div class="leg"><span class="badge walk">🚶</span><div><b>Walk ${fmtMin(leg.mins)}</b> ${leg.transfer ? 'to change at' : 'to'} ${esc(leg.to.n)}${leg.route ? `<small>${word(leg.route.nice)} stretch · ${facts(leg.route)}${leg.route.highlights.length ? ' · passes ' + esc(leg.route.highlights[0].name) : ''}</small>` : ''}${leg.route && leg.route.dangerM > 50 ? `<small style="color:var(--red)">Passes through ${esc(leg.route.danger.map(z => z.name).join(', '))} (higher reported crime)</small>` : ''}</div></div>`; }
        else { const col = lineColor(leg); h += `<div class="leg"><span class="badge" style="background:${col};color:${textOn(col)}">${esc(leg.ref.slice(0, 12))}</span><div><b>${esc(leg.from)} → ${esc(leg.to)}</b><small>${leg.toward ? 'Toward ' + esc(leg.toward) + ' · ' : ''}${leg.stops} stop${leg.stops > 1 ? 's' : ''} · about ${fmtMin(leg.mins)}</small></div></div>`; }
      }
      h += `<p style="color:var(--muted);font-size:12px">Train times are estimates from the route map, not live schedules. Allow for waiting.</p>`;
      h += `<div class="row"><button class="ghost" id="shareBtn">Share</button></div>`;
    } else {
      const c = sel;
      h += notesFor(st.sel).map(noteHtml).join('');
      if (c.highlights.length || c.parks.length) {
        const names = [...new Set(c.parks.map(p => p.name).concat(c.highlights.map(x => x.name)))].slice(0, 8);
        h += `<h3>You'll pass</h3><div class="pass">${names.map(n => `<span>${esc(n)}</span>`).join('')}</div>`;
      }
      h += `<div class="row"><button class="cta" id="startBtn">Start walking</button><button class="ghost" id="shareBtn">Share</button></div>`;
      h += `<h3>${fmtDist(c.len)} · ${c.nice}/100 niceness</h3><ol class="steps">${c.steps.map(s => `<li>${esc(s.text)}<span>${fmtDist(s.m)}</span></li>`).join('')}<li>${st.mode === 'loop' ? 'Back where you started' : 'Arrive at ' + esc(st.to.label || 'your destination')}<span></span></li></ol>`;
    }
    $('#detail').innerHTML = h; $('#detail').scrollTop = 0;
    const sc = $('#cards').querySelector('[aria-pressed=true]'); if (sc) $('#cards').scrollLeft = Math.max(0, sc.offsetLeft - 14);
    $('#sheet').classList.add('open');
    layoutFabs(); if (fit && bounds && bounds.isValid()) fitTo(bounds);
  }
  function notesFor(i) {
    // notes were written for the recommended route; when the user picks another, describe that choice instead
    const c = st.cards[i]; if (st.notes._for == null) st.notes._for = st.sel; if (i === st.notes._for) return st.notes.filter(n => n.kind !== 'transit' || true);
    const base = st.cards[st.notes._for], out = [];
    if (c.dangerM > 50) out.push({ kind: 'warn', text: `Heads up: about ${fmtDist(c.dangerM)} of this route is in ${c.danger.map(z => z.name).join(' and ') || 'a higher-crime area'}, where reported crime is higher.`, idx: st.notes._for, cta: 'Back to the recommended route' });
    if (!base.transit && !c.transit) { const d = c.mins - base.mins; out.push({ kind: 'info', text: `${d >= 0 ? fmtMin(d) + ' longer' : fmtMin(-d) + ' quicker'} than the recommended route, ${c.nice >= base.nice ? 'and' : 'but'} it scores ${c.nice}/100 for niceness against ${base.nice}.`, idx: st.notes._for, cta: 'Back to the recommended route' }); }
    return out.concat(st.notes.filter(n => n.kind === 'transit'));
  }
  function fitTo(b) {
    const mobile = innerWidth < 820, sh = $('#sheet').offsetHeight, tp = $('#top').offsetHeight;
    map.invalidateSize(); map.fitBounds(b, Object.assign({ animate: false, maxZoom: 17 }, mobile ? { paddingTopLeft: [30, tp + 30], paddingBottomRight: [30, sh + 20] } : { paddingTopLeft: [430, 40], paddingBottomRight: [40, 40] }));
  }
  function layoutFabs() { const s = $('#sheet'); $('#fabs').style.bottom = s.classList.contains('open') && innerWidth < 820 ? (s.offsetHeight + 12) + 'px' : ''; }
  function collapseTop(c) { $('#top').classList.toggle('collapsed', c); if (c) $('#sumText').textContent = st.mode === 'loop' ? `${st.loop} min scenic loop` : `${st.fromIsGps ? 'You' : (st.from.label || 'Start')} → ${st.to.label || 'pin'}`; }
  function clearResult() { st.cards = []; lRoute.clearLayers(); $('#sheet').classList.remove('open'); layoutFabs(); }

  /* ---------- live navigation ---------- */
  function startNav() {
    const r = st.cards[st.sel]; if (!r || r.transit) return;
    st.nav = { r, idx: 0, off: 0 }; document.body.classList.add('nav'); $('#sheet').classList.add('peek'); layoutFabs();
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then(w => st.nav && (st.nav.wake = w)).catch(() => { });
    if (!st.gps) toast('Turn on location to follow along. Showing the first step for now.');
    tickNav(); if (st.gps) map.setView([st.gps.lat, st.gps.lon], Math.max(map.getZoom(), 17));
  }
  function endNav() { if (!st.nav) return; if (st.nav.wake) st.nav.wake.release().catch(() => { }); st.nav = null; document.body.classList.remove('nav'); $('#sheet').classList.remove('peek'); layoutFabs(); }
  function tickNav() {
    const n = st.nav; if (!n) return; const r = n.r, co = r.coords;
    let best = n.idx, bd = Infinity;
    if (st.gps) {
      const scan = (i0, i1) => { for (let i = i0; i < i1; i++) { const d = Core.dist(st.gps.lat, st.gps.lon, co[i][0], co[i][1]); if (d < bd) { bd = d; best = i; } } };
      scan(Math.max(0, n.idx - 5), Math.min(co.length, n.idx + 80));
      if (bd > 45) scan(0, co.length); // lost the thread (GPS jump, shortcut, late start): look along the whole route
      n.idx = best;
    }
    let left = 0; for (let i = n.idx; i + 1 < co.length; i++) left += Core.dist(co[i][0], co[i][1], co[i + 1][0], co[i + 1][1]);
    let si = 0; r.steps.forEach((s, k) => { if (s.i <= n.idx) si = k; });
    const next = r.steps[si + 1];
    let toNext = 0; if (next) for (let i = n.idx; i < next.i && i + 1 < co.length; i++) toNext += Core.dist(co[i][0], co[i][1], co[i + 1][0], co[i + 1][1]);
    if (left < 25 && st.gps) { $('#navStep').textContent = st.mode === 'loop' ? 'Back where you started. Nice walk.' : 'You have arrived.'; $('#navLeft').textContent = ''; return; }
    if (st.gps && bd > 70) { n.off++; $('#navStep').textContent = 'You are off the route'; $('#navLeft').innerHTML = `${fmtDist(bd)} away · <a href="#" id="reroute" style="color:inherit;font-weight:600">Re-route from here</a>`; const a = $('#reroute'); if (a) a.onclick = e => { e.preventDefault(); if (st.mode === 'go') { setFrom({ lat: st.gps.lat, lon: st.gps.lon }, true); go().then(() => startNav()); } else endNav(); }; return; }
    $('#navStep').textContent = next ? `In ${fmtDist(toNext)}: ${next.text.replace(/^./, c => c.toLowerCase())}` : r.steps[si].text;
    $('#navLeft').textContent = `${r.steps[si].text.replace(/^(Head along|Continue on|Turn \w+ onto|Bear \w+ onto|Take the) /, 'On ')} · ${fmtMin(left / Core.WALK)} left (${fmtDist(left)})`;
  }

  /* ---------- geolocation ---------- */
  let meMarker = null, accCircle = null, firstFix = true, wantCenter = false;
  function onPos(pos) {
    const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    st.gps = p;
    if (!meMarker) { accCircle = L.circle([p.lat, p.lon], { radius: pos.coords.accuracy, color: '#2f6fde', weight: 0, fillOpacity: .12 }).addTo(lMe); meMarker = L.marker([p.lat, p.lon], { icon: icon('dot', 18), zIndexOffset: 500, interactive: false }).addTo(lMe); }
    meMarker.setLatLng([p.lat, p.lon]); accCircle.setLatLng([p.lat, p.lon]).setRadius(Math.min(pos.coords.accuracy, 300));
    if (firstFix) { firstFix = false; if (!shared && !st.cards.length) { setFrom({ lat: p.lat, lon: p.lon }, true); map.setView([p.lat, p.lon], 15); if (!st.city) toast('You are outside the six featured cities. Routing still works here using live OpenStreetMap data, without curated spots or crime areas.', 8000); } }
    else if (st.fromIsGps && !st.cards.length) st.from = { lat: p.lat, lon: p.lon };
    if (wantCenter) { wantCenter = false; map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16)); }
    if (st.nav) { tickNav(); map.panTo([p.lat, p.lon], { animate: true }); }
  }
  function locate(center) {
    if (!navigator.geolocation) return toast('This browser cannot share location.');
    wantCenter = !!center;
    if (st.gps && center) { map.setView([st.gps.lat, st.gps.lon], Math.max(map.getZoom(), 16)); wantCenter = false; }
    if (locate.w != null) return;
    locate.w = navigator.geolocation.watchPosition(onPos, e => { locate.w != null && navigator.geolocation.clearWatch(locate.w); locate.w = null; if (center) toast(e.code === 1 ? 'Location is blocked. Allow it in your browser settings, or search or tap the map to set a start.' : 'Could not get your location. Search or tap the map to set a start.'); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }

  /* ---------- search ---------- */
  let sugT, sugSeq = 0;
  function attachSearch(inp, pick) {
    const box = document.createElement('div'); box.id = 'sugg'; box.hidden = true;
    const show = items => { box.innerHTML = ''; items.forEach(it => { const b = document.createElement('button'); b.innerHTML = `${esc(it.label)}<small>${esc(it.sub)}</small>`; b.onmousedown = b.ontouchstart = e => { e.preventDefault(); box.hidden = true; inp.blur(); pick(it); }; box.appendChild(b); }); box.hidden = !items.length; inp.parentNode.appendChild(box); };
    const query = async () => {
      const q = inp.value.trim(); if (q.length < 3) { box.hidden = true; return []; }
      const my = ++sugSeq, c = st.from || { lat: map.getCenter().lat, lon: map.getCenter().lng };
      try {
        const j = await getJSON(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en&lat=${c.lat.toFixed(3)}&lon=${c.lon.toFixed(3)}&location_bias_scale=0.4`);
        if (my !== sugSeq) return [];
        const items = j.features.map(f => { const p = f.properties, g = f.geometry.coordinates; const label = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || q; return { label, sub: [p.name && p.street ? [p.housenumber, p.street].filter(Boolean).join(' ') : '', p.district || p.locality, p.city, p.state].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i && v !== label).slice(0, 3).join(', '), lat: g[1], lon: g[0] }; });
        show(items); return items;
      } catch (e) { return []; }
    };
    inp.addEventListener('input', () => { clearTimeout(sugT); sugT = setTimeout(query, 280); });
    inp.addEventListener('keydown', async e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(sugT); const items = await query(); if (items[0]) { box.hidden = true; inp.blur(); pick(items[0]); } else toast('No place found for that. Try a fuller name or tap the map.'); } });
    inp.addEventListener('blur', () => setTimeout(() => box.hidden = true, 150));
    inp.addEventListener('focus', () => inp.select());
  }

  /* ---------- wiring ---------- */
  attachSearch($('#to'), it => { setTo(it); map.setView([it.lat, it.lon], Math.max(map.getZoom(), 14)); go(); });
  attachSearch($('#from'), it => { setFrom(it, false); map.setView([it.lat, it.lon], 15); });
  $('#useGps').onclick = () => { if (st.gps) { setFrom({ lat: st.gps.lat, lon: st.gps.lon }, true); map.setView([st.gps.lat, st.gps.lon], 15); } else { firstFix = true; shared = false; locate(true); } };
  $('#modeGo').onclick = () => { setMode('go'); clearResult(); }; $('#modeLoop').onclick = () => { setMode('loop'); clearResult(); };
  chips($('#extraChips'), [0, 5, 10, 15, 20, 30], st.extra, v => v ? `+${v} min` : 'None', v => st.extra = v);
  chips($('#loopChips'), [15, 30, 45, 60, 90], st.loop, v => v + ' min', v => st.loop = v);
  $('#goBtn').onclick = go;
  $('#editBtn').onclick = () => collapseTop(false);
  $('#grab').onclick = () => { $('#sheet').classList.toggle('peek'); layoutFabs(); };
  $('#cards').onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; st.sel = +b.dataset.i; $('#sheet').classList.remove('peek'); render(true); if (st.cards[st.sel].transit && !st.cards[st.sel].transit.loaded) { busy('Finding nice walks to the stations…'); loadTransitLegs(st.cards[st.sel]); } };
  $('#detail').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.i != null) { st.sel = +b.dataset.i; render(true); if (st.cards[st.sel].transit && !st.cards[st.sel].transit.loaded) { busy('Finding nice walks to the stations…'); loadTransitLegs(st.cards[st.sel]); } }
    else if (b.id === 'startBtn') startNav();
    else if (b.id === 'shareBtn') share();
  };
  $('#navEnd').onclick = endNav;
  $('#fabLocate').onclick = () => locate(true);
  $('#fabZones').onclick = () => { st.zonesOn = !st.zonesOn; $('#fabZones').setAttribute('aria-pressed', st.zonesOn); st.zonesOn ? map.addLayer(lZones) : map.removeLayer(lZones); toast(st.zonesOn ? 'Showing areas with higher reported crime. Routes steer around them when they can.' : 'Hiding the crime-area overlay. Routes still steer around those areas.'); };
  $('#fabNight').onclick = () => { setNight(!st.night); toast(st.night ? 'After-dark mode: routes prefer lit streets over unlit park paths.' : 'Daytime mode.'); if (st.cards.length) go(); };
  $('#cityBtn').onclick = () => $('#cityMenu').classList.add('open');
  $('#cityMenu').onclick = e => { if (e.target.id === 'cityMenu') $('#cityMenu').classList.remove('open'); };
  $('#cityList').innerHTML = CITIES.map(c => `<button data-c="${c.id}">${esc(c.name)}<small>${esc(c.transitName)} · ${c.spots.length} scenic spots</small></button>`).join('');
  $('#cityList').onclick = e => { const b = e.target.closest('[data-c]'); if (!b) return; const c = CITIES.find(x => x.id === b.dataset.c); $('#cityMenu').classList.remove('open'); clearResult(); collapseTop(false); setCity(c); if (st.gps && inBox(st.gps, c.bbox)) { setFrom({ lat: st.gps.lat, lon: st.gps.lon }, true); map.setView([st.gps.lat, st.gps.lon], 15); } else { setFrom(Object.assign({}, c.start), false); map.setView([c.start.lat, c.start.lon], c.zoom); } setTo(null); };
  function share() {
    const f = st.from, t = st.to, q = st.mode === 'loop' ? `?from=${f.lat.toFixed(5)},${f.lon.toFixed(5)}&loop=${st.loop}` : `?from=${f.lat.toFixed(5)},${f.lon.toFixed(5)}&to=${t.lat.toFixed(5)},${t.lon.toFixed(5)}&x=${st.extra}&n=${encodeURIComponent(t.label || '')}`;
    const url = location.origin + location.pathname + q;
    if (navigator.share) navigator.share({ title: 'Meander', text: st.mode === 'loop' ? 'A scenic walk' : 'The nicest way to ' + (t.label || 'there'), url }).catch(() => { });
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('Link copied.'), () => toast(url, 9000)); else toast(url, 9000);
  }
  addEventListener('resize', layoutFabs);

  /* ---------- boot ---------- */
  setNight(st.night); drawCity(); if (map.getZoom() >= 13) map.addLayer(lSpots);
  const qs = new URLSearchParams(location.search), ll = s => { const m = /^(-?\d+\.?\d*),(-?\d+\.?\d*)$/.exec(s || ''); return m ? { lat: +m[1], lon: +m[2] } : null; };
  let shared = false;
  const qf = ll(qs.get('from')), qt = ll(qs.get('to'));
  if (qf && (qt || qs.get('loop'))) {
    shared = true; qf.label = 'Shared start'; setFrom(qf, false);
    if (qt) { qt.label = qs.get('n') || 'Shared destination'; setTo(qt); st.extra = +qs.get('x') || 0; chips($('#extraChips'), [0, 5, 10, 15, 20, 30], st.extra, v => v ? `+${v} min` : 'None', v => st.extra = v); setMode('go'); }
    else { st.loop = clamp(+qs.get('loop') || 30, 10, 120); setMode('loop'); }
    map.setView([qf.lat, qf.lon], 14); go();
  } else {
    let c = CITIES[0]; try { c = CITIES.find(x => x.id === localStorage.getItem('meander.city')) || c; } catch (e) { }
    setCity(c); setFrom(Object.assign({}, c.start), false); map.setView([c.start.lat, c.start.lon], c.zoom); setMode('go');
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  locate(false);
  window.__meander = { st, go, setFrom, setTo, setMode, map };
})();
