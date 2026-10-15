/* AeroLog — interface web (vanilla JS + MapLibre GL) */
(() => {
  'use strict';

  /* ================= Utilitaires ================= */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const view = $('#view');
  const fmtInt = n => Math.round(n || 0).toLocaleString('fr-FR');
  const fmtDur = m => (m == null ? '—' : `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')}`);
  const fmtHours = m => fmtInt((m || 0) / 60);
  const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  const fmtDate = d => { if (!d) return ''; const [y, m, j] = d.split('-'); return `${+j} ${MONTHS[+m - 1]} ${y}`; };
  const ROLE = { passenger: 'Passager', crew: 'Équipage', deadhead: 'MEP' };
  const ROLE_COLOR = { passenger: '#5cc8ff', crew: '#f5b544', deadhead: '#b48cff' };
  const CLASS = { economy: 'Économique', premium: 'Premium', business: 'Affaires', first: 'Première', crew: 'Équipage' };
  const SEAT = { window: 'Hublot', middle: 'Milieu', aisle: 'Couloir', jumpseat: 'Strapontin', cockpit: 'Cockpit', crewrest: 'Crew rest' };
  const REASON = { leisure: 'Loisirs', business: 'Affaires', work: 'Travail (PN)', personal: 'Personnel', other: 'Autre' };
  const badge = r => `<span class="badge ${r}">${ROLE[r] || r}</span>`;
  const logo = code => (code && code.length === 2 ? `<img src="https://pics.avs.io/120/40/${esc(code)}.png" alt="" loading="lazy" onerror="this.remove()">` : '');

  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), err ? 5000 : 2600);
  }

  async function api(url, opts = {}) {
    const o = { ...opts, headers: { ...(opts.headers || {}) } };
    if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(url, o);
    if (r.status === 401 && !url.endsWith('/login')) { renderLogin(); throw new Error('auth'); }
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error((data && data.error) || `Erreur ${r.status}`);
    return data;
  }
  const readFile = f => new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ko; r.readAsText(f); });

  /* ================= État global & filtres ================= */
  const state = { role: localStorage.getItem('al.role') || '', year: localStorage.getItem('al.year') || '', meta: null };
  const qs = (extra = {}) => new URLSearchParams(Object.entries({ role: state.role, year: state.year, ...extra }).filter(([, v]) => v)).toString();

  function syncFilters(years) {
    $$('#roleFilter button').forEach(b => b.classList.toggle('on', b.dataset.role === state.role));
    if (years) {
      const sel = $('#yearFilter');
      sel.innerHTML = '<option value="">Toutes années</option>' + years.map(y => `<option ${y === state.year ? 'selected' : ''}>${y}</option>`).join('');
      if (state.year && !years.includes(state.year)) { state.year = ''; localStorage.removeItem('al.year'); }
    }
  }
  $('#roleFilter').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.role = b.dataset.role; localStorage.setItem('al.role', state.role); syncFilters(); route();
  });
  $('#yearFilter').addEventListener('change', e => { state.year = e.target.value; localStorage.setItem('al.year', state.year); route(); });

  /* ================= Cartographie (MapLibre GL + OpenFreeMap) ================= */
  const BASEMAPS = {
    dark: { label: 'Sombre', url: 'https://tiles.openfreemap.org/styles/dark' },
    fiord: { label: 'Fiord', url: 'https://tiles.openfreemap.org/styles/fiord' },
    positron: { label: 'Clair', url: 'https://tiles.openfreemap.org/styles/positron' },
    liberty: { label: 'Liberty', url: 'https://tiles.openfreemap.org/styles/liberty' },
    bright: { label: 'Bright', url: 'https://tiles.openfreemap.org/styles/bright' },
  };
  // Fond minimal utilisé si le serveur de tuiles est injoignable : les vols restent visibles
  const FALLBACK_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0a0f1b' } }] };
  const mapPrefs = {
    get style() { return localStorage.getItem('al.style') || (state.meta && state.meta.mapStyle) || 'dark'; },
    set style(v) { localStorage.setItem('al.style', v); },
    get globe() { const v = localStorage.getItem('al.globe'); return v == null ? true : v === '1'; },
    set globe(v) { localStorage.setItem('al.globe', v ? '1' : '0'); },
  };
  const styleUrl = key => (BASEMAPS[key] ? BASEMAPS[key].url : /^https?:\/\//.test(key) ? key : BASEMAPS.dark.url);
  const lonlat = p => [p[1], p[0]]; // [lat,lon] → [lon,lat]

  // Contrôle « fond de carte + globe »
  class BasemapControl {
    constructor(w) { this.w = w; }
    onAdd() {
      const el = document.createElement('div');
      el.className = 'maplibregl-ctrl maplibregl-ctrl-group basemap-ctrl';
      const custom = !BASEMAPS[mapPrefs.style];
      el.innerHTML = `<select title="Fond de carte">${custom ? '<option value="custom" selected>Personnalisé</option>' : ''}${Object.entries(BASEMAPS).map(([k, b]) => `<option value="${k}" ${k === mapPrefs.style ? 'selected' : ''}>${b.label}</option>`).join('')}</select>
        <button type="button" class="globe-btn ${mapPrefs.globe ? 'on' : ''}" title="Vue globe / plane">🌐</button>`;
      $('select', el).onchange = e => { mapPrefs.style = e.target.value; maps.forEach(m => m.setBasemap()); };
      $('button', el).onclick = () => { mapPrefs.globe = !mapPrefs.globe; maps.forEach(m => m.applyProjection()); $$('.globe-btn').forEach(b => b.classList.toggle('on', mapPrefs.globe)); };
      return el;
    }
    onRemove() {}
  }

  const maps = [];
  function newMap(el, opts = {}) {
    const map = new maplibregl.Map({
      container: el, style: styleUrl(mapPrefs.style), center: [2, 46], zoom: 3,
      attributionControl: { compact: true }, renderWorldCopies: true, maxPitch: 0, dragRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    const w = { map, sources: new Map(), markers: [], ready: false, fitArgs: null };

    w.applyProjection = () => { try { map.setProjection({ type: mapPrefs.globe && !opts.flat ? 'globe' : 'mercator' }); } catch (_) { /* style pas prêt */ } };
    w.restore = () => {
      w.ready = true;
      w.applyProjection();
      for (const [id, s] of w.sources) addSource(id, s);
    };
    w.setBasemap = () => { fellBack = false; map.setStyle(styleUrl(mapPrefs.style)); };
    let fellBack = false;
    map.on('style.load', w.restore);
    map.on('error', e => {
      // Style ou tuiles de base injoignables : bascule sur le fond minimal
      if (!map.isStyleLoaded() && !fellBack) { fellBack = true; console.warn('Fond de carte indisponible', e.error && e.error.message); map.setStyle(FALLBACK_STYLE); }
    });
    setTimeout(() => { if (!w.ready && !fellBack) { fellBack = true; map.setStyle(FALLBACK_STYLE); } }, 8000);

    if (!opts.minimal) {
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
      map.addControl(new maplibregl.FullscreenControl(), 'top-left');
      map.addControl(new BasemapControl(w), 'top-right');
    }

    function addSource(id, s) {
      if (map.getSource(id)) { map.getSource(id).setData(s.data); return; }
      map.addSource(id, { type: 'geojson', data: s.data, lineMetrics: false });
      s.layers.forEach(l => map.addLayer({ ...l, source: id }));
    }
    // Déclare (ou met à jour) une source GeoJSON et ses couches ; réappliquées à chaque changement de fond
    w.set = (id, data, layers) => {
      const s = w.sources.get(id) || { layers };
      s.data = data; w.sources.set(id, s);
      if (w.ready && map.isStyleLoaded()) addSource(id, s);
    };
    w.clear = () => {
      for (const id of w.sources.keys()) w.set(id, { type: 'FeatureCollection', features: [] });
      w.markers.forEach(m => m.remove()); w.markers = [];
    };
    w.fit = (latlons, o = {}) => {
      if (!latlons.length) return;
      const b = new maplibregl.LngLatBounds();
      latlons.forEach(p => b.extend(lonlat(p)));
      map.fitBounds(b, { padding: o.padding ?? 40, maxZoom: o.maxZoom ?? 9, duration: 0 });
    };
    // Repère d'aéroport en HTML (libellé permanent, indépendant des polices du style)
    w.label = (ap, color) => {
      if (!ap || ap.lat == null) return;
      const d = document.createElement('div');
      d.className = 'apt-mk';
      d.innerHTML = `<i style="background:${color}"></i><span>${esc(ap.code || ap.iata || ap.icao)} · ${esc(ap.city || ap.name)}</span>`;
      w.markers.push(new maplibregl.Marker({ element: d, anchor: 'left', offset: [-6, 0] }).setLngLat([ap.lon, ap.lat]).addTo(map));
    };
    w.remove = () => map.remove();
    new ResizeObserver(() => map.resize()).observe(el);
    maps.push(w);
    return w;
  }
  function clearMaps() { while (maps.length) maps.pop().remove(); }

  // Arc de grand cercle entre deux points, longitudes « déroulées » pour l'antiméridien
  function greatCircle(a, b, n = 96) {
    const r = Math.PI / 180, [la1, lo1, la2, lo2] = [a[0] * r, a[1] * r, b[0] * r, b[1] * r];
    const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
    if (d < 1e-6) return [a, b];
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
      const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
      const z = A * Math.sin(la1) + B * Math.sin(la2);
      pts.push([Math.atan2(z, Math.sqrt(x * x + y * y)) / r, Math.atan2(y, x) / r]);
    }
    return unwrap(pts);
  }
  function unwrap(pts) {
    const out = [pts[0].slice()];
    for (let i = 1; i < pts.length; i++) {
      let lon = pts[i][1];
      const prev = out[i - 1][1];
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
      out.push([pts[i][0], lon]);
    }
    return out;
  }
  const altColor = ft => {
    const t = Math.max(0, Math.min(1, (ft || 0) / 40000));
    // vert (sol) → cyan → bleu → violet → ambre (croisière haute)
    const stops = [[79, 209, 161], [92, 200, 255], [110, 140, 255], [180, 140, 255], [245, 181, 68]];
    const p = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), f = p - i;
    const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
    return `rgb(${c.join(',')})`;
  };
  const line = (latlons, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: latlons.map(lonlat) } });
  const fc = features => ({ type: 'FeatureCollection', features });
  // Trace découpée en tronçons de couleur homogène (altitude)
  function trackFeatures(track) {
    const pts = unwrap(track.map(p => [p[0], p[1]]));
    if (!track.some(p => p[2])) return [line(pts, { color: '#f5b544' })];
    const out = [];
    let run = [pts[0]], col = altColor(track[0][2]);
    for (let i = 1; i < pts.length; i++) {
      const c = altColor(track[i][2]);
      run.push(pts[i]);
      if (c !== col || i === pts.length - 1) { out.push(line(run, { color: col })); run = [pts[i]]; col = c; }
    }
    return out;
  }
  // Couche « route » : trace réelle (trait plein, couleur par tronçon) ou orthodromie (pointillés)
  function drawRoute(w, f, ap) {
    const dep = ap ? ap.dep : f.dep, arr = ap ? ap.arr : f.arr;
    const solid = f.track ? trackFeatures(f.track) : [];
    const dashed = !f.track && dep && arr && dep.lat != null && arr.lat != null ? [line(greatCircle([dep.lat, dep.lon], [arr.lat, arr.lon]), { color: ROLE_COLOR[f.role] || '#f5b544' })] : [];
    w.set('route-solid', fc(solid), [
      { id: 'route-casing', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#05080f', 'line-width': 6, 'line-opacity': .55 } },
      { id: 'route-solid', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 3.4 } },
    ]);
    w.set('route-dashed', fc(dashed), [{ id: 'route-dashed', type: 'line', layout: { 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 2.6, 'line-dasharray': [2, 2] } }]);
    const pts = f.track ? unwrap(f.track.map(p => [p[0], p[1]])) : dashed.length ? dashed[0].geometry.coordinates.map(c => [c[1], c[0]]) : [];
    return pts;
  }

  /* ================= Routeur ================= */
  const routes = [
    [/^\/?$/, renderHome, 'home'],
    [/^\/flights$/, renderFlights, 'flights'],
    [/^\/new$/, () => renderForm(null), 'flights'],
    [/^\/flight\/(\d+)$/, id => renderDetail(+id), 'flights'],
    [/^\/flight\/(\d+)\/edit$/, id => renderForm(+id), 'flights'],
    [/^\/stats$/, renderStats, 'stats'],
    [/^\/data$/, renderData, 'data'],
  ];
  async function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    clearMaps();
    for (const [re, fn, nav] of routes) {
      const m = h.match(re);
      if (m) {
        $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === nav));
        $('#globalFilters').style.visibility = ['home', 'flights', 'stats'].includes(nav) && !/new|edit/.test(h) ? 'visible' : 'hidden';
        view.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
        try { await fn(...m.slice(1)); } catch (e) { if (e.message !== 'auth') view.innerHTML = `<div class="empty"><h2>Erreur</h2><p>${esc(e.message)}</p></div>`; }
        window.scrollTo(0, 0);
        return;
      }
    }
    location.hash = '#/';
  }
  window.addEventListener('hashchange', route);

  /* ================= Connexion ================= */
  function renderLogin() {
    clearMaps();
    $('.topbar').style.display = 'none';
    view.innerHTML = `<form class="panel login"><h1>Aero<b style="color:var(--accent)">Log</b></h1>
      <div class="field"><label>Mot de passe</label><input type="password" name="pw" autofocus required></div>
      <button class="btn primary">Se connecter</button></form>`;
    $('form', view).onsubmit = async e => {
      e.preventDefault();
      try { await api('/api/login', { method: 'POST', body: { password: e.target.pw.value } }); $('.topbar').style.display = ''; route(); }
      catch (err) { toast(err.message, true); }
    };
  }

  /* ================= Tableau de bord ================= */
  function kpiHtml(t) {
    return `<div class="kpis">
      <div class="kpi"><div class="label">Vols</div><div class="value">${fmtInt(t.flights)}</div><div class="sub">${fmtInt(t.tracks)} avec trace réelle</div></div>
      <div class="kpi"><div class="label">Distance</div><div class="value">${fmtInt(t.km)}<small>km</small></div><div class="sub">${t.earth.toFixed(1).replace('.', ',')} × le tour de la Terre</div></div>
      <div class="kpi"><div class="label">Temps de vol</div><div class="value">${fmtHours(t.min)}<small>h</small></div><div class="sub">${(t.min / 1440).toFixed(1).replace('.', ',')} jours en l'air</div></div>
      <div class="kpi"><div class="label">Aéroports</div><div class="value">${fmtInt(t.airports)}</div><div class="sub">${fmtInt(t.countries)} pays</div></div>
      <div class="kpi"><div class="label">Compagnies</div><div class="value">${fmtInt(t.airlines)}</div><div class="sub">&nbsp;</div></div>
      <div class="kpi"><div class="label">Avions</div><div class="value">${fmtInt(t.aircraft)}</div><div class="sub">${fmtInt(t.registrations)} immatriculations</div></div>
    </div>`;
  }

  async function renderHome() {
    const [stats, flights, tracks] = await Promise.all([api('/api/stats?' + qs()), api('/api/flights?' + qs()), api('/api/tracks?' + qs())]);
    syncFilters(stats.years);
    if (!flights.length && !state.role && !state.year) {
      view.innerHTML = `<div class="empty"><h2>Bienvenue dans AeroLog</h2><p>Aucun vol enregistré pour l'instant.<br>Ajoutez un vol à la main, depuis un KML Flightradar24, ou importez une sauvegarde.</p>
        <a class="btn primary" href="#/new">+ Ajouter un vol</a> <a class="btn" href="#/data">Importer</a></div>`;
      return;
    }
    view.innerHTML = kpiHtml(stats.totals) + `
      <div class="dash">
        <section class="panel"><header><h2>Carte des vols</h2>
          <div class="legend"><span><i style="background:${ROLE_COLOR.passenger}"></i>Passager</span><span><i style="background:${ROLE_COLOR.crew}"></i>Équipage</span><span><i style="background:${ROLE_COLOR.deadhead}"></i>MEP</span></div></header>
          <div id="map" class="map tall"></div></section>
        <section class="panel"><header><h2>Derniers vols</h2><a class="btn ghost sm" href="#/flights">Tout voir →</a></header>
          <ul class="flight-list">${flights.slice(0, 9).map(f => {
            const [, m, d] = f.date.split('-');
            return `<li><a href="#/flight/${f.id}"><div class="date"><b>${+d}</b>${MONTHS[+m - 1]}</div>
              <div><div class="route">${esc(f.dep_code)}<span class="arrow">→</span>${esc(f.arr_code)}</div>
              <div class="muted" style="font-size:12px">${esc(f.flight_number || '')} ${esc(f.airline_name || '')}${f.aircraft_type ? ' · ' + esc(f.aircraft_type) : ''}</div></div>
              <div style="text-align:right">${badge(f.role)}<div class="dim mono" style="font-size:12px;margin-top:3px">${fmtDur(f.duration_min)}</div></div></a></li>`;
          }).join('')}</ul></section>
      </div>`;
    drawOverview($('#map'), flights, tracks);
  }

  function drawOverview(el, flights, tracks) {
    const w = newMap(el), map = w.map;
    const trackById = new Map(tracks.map(t => [t.id, t.path]));
    const seen = new Map(), lines = [];
    // Les vols les plus anciens d'abord : les récents sont dessinés par-dessus
    for (const f of [...flights].reverse()) {
      if (f.dep.lat == null || f.arr.lat == null) continue;
      const real = trackById.has(f.id);
      const path = real ? unwrap(trackById.get(f.id)) : greatCircle([f.dep.lat, f.dep.lon], [f.arr.lat, f.arr.lon], 64);
      lines.push(line(path, { id: f.id, color: ROLE_COLOR[f.role] || '#fff', real: real ? 1 : 0, label: `${f.dep_code} → ${f.arr_code} · ${fmtDate(f.date)}${f.flight_number ? ' · ' + f.flight_number : ''}` }));
      for (const a of [f.dep, f.arr]) seen.set(a.code, { ...a, n: (seen.get(a.code)?.n || 0) + 1 });
    }
    const apts = [...seen.values()].map(a => ({ type: 'Feature', properties: { label: `${a.code} · ${a.city || a.name} (${a.n})`, n: a.n }, geometry: { type: 'Point', coordinates: [a.lon, a.lat] } }));
    w.set('flights', fc(lines), [
      { id: 'flights', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['==', ['get', 'real'], 1], 2, 1.6], 'line-opacity': .6 } },
      { id: 'flights-hit', type: 'line', paint: { 'line-color': '#000', 'line-width': 10, 'line-opacity': 0 } },
    ]);
    w.set('airports', fc(apts), [{
      id: 'airports', type: 'circle',
      paint: { 'circle-radius': ['min', 9, ['+', 3, ['*', 1.2, ['ln', ['get', 'n']]]]], 'circle-color': '#e6ecf7', 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.5 },
    }]);
    const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'apt-pop', offset: 8 });
    for (const layer of ['flights-hit', 'airports']) {
      map.on('mousemove', layer, e => { map.getCanvas().style.cursor = layer === 'flights-hit' ? 'pointer' : ''; pop.setLngLat(e.lngLat).setText(e.features[0].properties.label).addTo(map); });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; pop.remove(); });
    }
    map.on('click', 'flights-hit', e => (location.hash = `#/flight/${e.features[0].properties.id}`));
    const pts = [...seen.values()].map(a => [a.lat, a.lon]);
    if (pts.length) w.fit(pts, { padding: 50, maxZoom: 6 });
  }

  /* ================= Liste des vols ================= */
  async function renderFlights() {
    const q = sessionStorage.getItem('al.q') || '';
    view.innerHTML = `<div class="toolbar"><h1>Carnet de vols</h1>
      <input type="search" id="q" placeholder="Rechercher (aéroport, vol, immat., notes…)" value="${esc(q)}">
      <a class="btn" href="/api/export.csv">Export CSV</a></div>
      <section class="panel" id="list"><div class="empty"><span class="spinner"></span></div></section>`;
    const load = async () => {
      const qv = $('#q').value.trim(); sessionStorage.setItem('al.q', qv);
      const [flights, stats] = await Promise.all([api('/api/flights?' + qs({ q: qv })), api('/api/stats?' + qs({ q: qv }))]);
      syncFilters(stats.years);
      if (!flights.length) { $('#list').innerHTML = '<div class="empty"><h2>Aucun vol</h2><p>Aucun vol ne correspond aux filtres.</p></div>'; return; }
      let lastYear = '';
      $('#list').innerHTML = `<table class="flights"><thead><tr>
        <th>Date</th><th>Trajet</th><th class="hide-sm">Vol</th><th class="hide-sm">Avion</th><th>Rôle</th><th class="r">Durée</th><th class="r hide-sm">Distance</th></tr></thead><tbody>
        ${flights.map(f => {
          const y = f.date.slice(0, 4); let sep = '';
          if (y !== lastYear) { lastYear = y; sep = `<tr class="year-sep"><td colspan="7">${y}</td></tr>`; }
          return sep + `<tr data-id="${f.id}">
            <td class="mono num">${esc(f.date.slice(8, 10))}/${esc(f.date.slice(5, 7))}<div class="dim" style="font-size:12px">${esc(f.dep_time || f.dep_time_sched || '')}</div></td>
            <td><div class="route">${esc(f.dep_code)}<span class="arrow">→</span>${esc(f.arr_code)}</div><div class="muted" style="font-size:12px">${esc(f.dep.city)} → ${esc(f.arr.city)}</div></td>
            <td class="hide-sm"><div class="al">${logo(f.airline_code)}<div><div class="mono">${esc(f.flight_number || '—')}</div><div class="muted" style="font-size:12px">${esc(f.airline_name || '')}</div></div></div></td>
            <td class="hide-sm"><div class="mono">${esc(f.aircraft_type || '—')}</div><div class="muted" style="font-size:12px">${esc(f.aircraft_reg || '')}</div></td>
            <td>${badge(f.role)}${f.crew_function ? `<div class="dim" style="font-size:11px;margin-top:3px">${esc(f.crew_function)}</div>` : ''}${f.has_track ? ' <span class="badge track" title="Trace réelle importée">trace</span>' : ''}</td>
            <td class="r mono num">${fmtDur(f.duration_min)}</td>
            <td class="r mono num hide-sm">${fmtInt(f.distance_km)} km</td></tr>`;
        }).join('')}</tbody></table>`;
      $$('tbody tr[data-id]', $('#list')).forEach(tr => tr.onclick = () => (location.hash = `#/flight/${tr.dataset.id}`));
    };
    let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
    await load();
  }

  /* ================= Détail d'un vol ================= */
  async function renderDetail(id) {
    const f = await api(`/api/flights/${id}`);
    const fact = (k, v) => (v == null || v === '' ? '' : `<div><dt>${k}</dt><dd>${v}</dd></div>`);
    const t0 = f.track && f.track[0] && f.track[0][3], t1 = f.track && f.track[f.track.length - 1][3];
    const maxAlt = f.track ? Math.max(...f.track.map(p => p[2] || 0)) : 0;
    const maxSpd = f.track ? Math.max(...f.track.map(p => p[4] || 0)) : 0;
    view.innerHTML = `
      <section class="panel"><div class="hero">
        <div class="apt"><div class="code">${esc(f.dep_code)}</div><div class="city">${esc(f.dep.city)} · ${esc(f.dep.country)}</div>
          <div class="time">${esc(f.dep_time || f.dep_time_sched || '--:--')}${f.dep_time && f.dep_time_sched && f.dep_time !== f.dep_time_sched ? `<s>${esc(f.dep_time_sched)}</s>` : ''}</div></div>
        <div class="mid"><div>${fmtDate(f.date)}</div><div class="line"></div><div class="mono">${fmtDur(f.duration_min)} · ${fmtInt(f.distance_km)} km</div></div>
        <div class="apt" style="text-align:right"><div class="code">${esc(f.arr_code)}</div><div class="city">${esc(f.arr.city)} · ${esc(f.arr.country)}</div>
          <div class="time">${f.arr_time && f.arr_time_sched && f.arr_time !== f.arr_time_sched ? `<s style="margin:0 6px 0 0">${esc(f.arr_time_sched)}</s>` : ''}${esc(f.arr_time || f.arr_time_sched || '--:--')}${f.arr_date && f.arr_date !== f.date ? ' <span class="dim" style="font-size:12px">+1</span>' : ''}</div></div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;padding:0 20px 16px;flex-wrap:wrap">
        <div class="al">${logo(f.airline_code)}<span class="mono" style="font-size:16px">${esc(f.flight_number || '')}</span><span class="muted">${esc(f.airline_name || '')}</span></div>
        ${badge(f.role)}${f.crew_function ? `<span class="muted">${esc(f.crew_function)}</span>` : ''}
        <div class="actions" style="margin-left:auto;display:flex;gap:8px">
          <label class="btn" title="Importer une trace KML/CSV Flightradar24">${f.track ? 'Remplacer la trace' : 'Importer une trace KML'}<input type="file" id="trk" accept=".kml,.csv,application/vnd.google-earth.kml+xml,text/csv" hidden></label>
          ${f.track ? '<button class="btn ghost" id="deltrk">Retirer la trace</button>' : ''}
          <a class="btn" href="#/flight/${f.id}/edit">Modifier</a>
          <button class="btn danger" id="del">Supprimer</button>
        </div></div></section>
      <div class="detail">
        <div class="grid">
          <section class="panel"><header><h2>${f.track ? 'Trajectoire réelle' : 'Route orthodromique'}</h2>
            ${f.track ? `<div class="legend"><span><i style="background:${altColor(0)}"></i>sol</span><span><i style="background:${altColor(15000)}"></i>15 000 ft</span><span><i style="background:${altColor(40000)}"></i>40 000 ft</span></div>` : '<span class="dim" style="font-size:12px">Importez un KML Flightradar24 pour afficher la trace réelle</span>'}</header>
            <div id="map" class="map"></div></section>
          ${f.track && f.track.some(p => p[2]) ? `<section class="panel"><header><h2>Profil de vol</h2><span class="legend"><span><i style="background:var(--accent)"></i>Altitude (ft)</span>${maxSpd ? '<span><i style="background:var(--pax)"></i>Vitesse sol (kt)</span>' : ''}</span></header>
            <div class="body"><div class="profile-wrap"><canvas id="profile"></canvas></div></div></section>` : ''}
        </div>
        <div class="grid" style="align-content:start">
          <section class="panel"><header><h2>Informations</h2></header><dl class="facts" style="margin:0">
            ${fact('Indicatif', esc(f.callsign))}
            ${fact('Type avion', f.aircraft_type ? `${esc(f.aircraft_type)}` : '')}
            ${fact('Immatriculation', esc(f.aircraft_reg))}
            ${fact('Nom de l\'avion', esc(f.aircraft_name))}
            ${fact('Siège', [esc(f.seat), SEAT[f.seat_type]].filter(Boolean).join(' · '))}
            ${fact('Classe', CLASS[f.cabin_class])}
            ${fact('Motif', REASON[f.reason])}
            ${fact('Départ prévu', esc(f.dep_time_sched))}
            ${fact('Arrivée prévue', esc(f.arr_time_sched))}
            ${fact('Distance trace', f.track_distance_km ? fmtInt(f.track_distance_km) + ' km' : '')}
            ${fact('Altitude max', maxAlt ? fmtInt(maxAlt) + ' ft' : '')}
            ${fact('Vitesse max', maxSpd ? fmtInt(maxSpd) + ' kt' : '')}
            ${fact('Début trace (UTC)', t0 ? new Date(t0 * 1000).toISOString().slice(11, 16) : '')}
            ${fact('Fin trace (UTC)', t1 ? new Date(t1 * 1000).toISOString().slice(11, 16) : '')}
            ${fact('Note', f.rating ? `<span class="stars">${'★'.repeat(f.rating)}${'<span class="dim">★</span>'.repeat(5 - f.rating)}</span>` : '')}
          </dl></section>
          ${f.notes ? `<section class="panel"><header><h2>Notes</h2></header><div class="body notes">${esc(f.notes)}</div></section>` : ''}
          <section class="panel"><header><h2>Aéroports</h2></header><div class="body" style="display:grid;gap:10px">
            ${[f.dep, f.arr].map(a => `<div><span class="mono" style="color:var(--accent)">${esc(a.iata || a.code)}</span> <span class="dim mono">${esc(a.icao || '')}</span><div>${esc(a.name)}</div><div class="muted" style="font-size:12px">${esc(a.city)}, ${esc(a.country)}${a.tz ? ' · ' + esc(a.tz) : ''}</div></div>`).join('')}
          </div></section>
        </div>
      </div>`;

    const w = newMap($('#map'));
    const pts = drawRoute(w, f);
    if (pts.length) w.fit(pts, { padding: 50, maxZoom: 9 });
    w.label(f.dep, '#4fd1a1'); w.label(f.arr, '#ff8a65');
    let marker = null;
    if ($('#profile')) drawProfile($('#profile'), f.track, i => {
      const p = f.track[i];
      if (!marker) { const d = document.createElement('div'); d.className = 'plane-mk'; marker = new maplibregl.Marker({ element: d }).setLngLat([p[1], p[0]]).addTo(w.map); }
      marker.setLngLat([p[1], p[0]]);
    });

    $('#del').onclick = async () => {
      if (!confirm(`Supprimer le vol ${f.dep_code} → ${f.arr_code} du ${fmtDate(f.date)} ?`)) return;
      await api(`/api/flights/${id}`, { method: 'DELETE' }); toast('Vol supprimé'); location.hash = '#/flights';
    };
    $('#trk').onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const r = await api(`/api/flights/${id}/track`, { method: 'PUT', body: { filename: file.name, content: await readFile(file) } });
        const g = r.guess, warn = [];
        if (g.dep_code && g.dep_code !== f.dep_code) warn.push(`départ détecté ${g.dep_code}`);
        if (g.arr_code && g.arr_code !== f.arr_code) warn.push(`arrivée détectée ${g.arr_code}`);
        toast(`Trace importée (${r.flight.track.length} points)${warn.length ? ' — attention : ' + warn.join(', ') : ''}`, !!warn.length);
        route();
      } catch (err) { toast(err.message, true); }
    };
    if ($('#deltrk')) $('#deltrk').onclick = async () => { if (!confirm('Retirer la trace de ce vol ?')) return; await api(`/api/flights/${id}/track`, { method: 'DELETE' }); route(); };
  }

  function drawProfile(canvas, track, onHover) {
    const hasTime = track[0][3] != null && track[track.length - 1][3] != null;
    const xs = hasTime ? track.map(p => p[3]) : track.map((_, i) => i);
    const alt = track.map(p => p[2] || 0), spd = track.map(p => p[4] || 0);
    const maxA = Math.max(1000, ...alt) * 1.08, maxS = Math.max(...spd) * 1.1 || 1;
    const x0 = xs[0], x1 = xs[xs.length - 1] || 1;
    const css = getComputedStyle(document.documentElement);
    let hover = -1;
    function draw() {
      const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      const c = canvas.getContext('2d'); c.scale(dpr, dpr);
      const pl = 52, pr = maxS > 1 ? 44 : 10, pt = 8, pb = 22, w = W - pl - pr, h = H - pt - pb;
      const X = v => pl + ((v - x0) / (x1 - x0 || 1)) * w, YA = v => pt + h - (v / maxA) * h, YS = v => pt + h - (v / maxS) * h;
      c.font = '11px ' + css.getPropertyValue('--mono'); c.fillStyle = css.getPropertyValue('--dim'); c.strokeStyle = css.getPropertyValue('--line');
      for (let i = 0; i <= 4; i++) {
        const v = (maxA / 4) * i, y = YA(v);
        c.beginPath(); c.moveTo(pl, y); c.lineTo(W - pr, y); c.stroke();
        c.textAlign = 'right'; c.fillText(Math.round(v / 1000) + 'k', pl - 6, y + 4);
        if (maxS > 1) { c.textAlign = 'left'; c.fillText(Math.round((maxS / 4) * i), W - pr + 6, y + 4); }
      }
      if (hasTime) {
        c.textAlign = 'center';
        const span = x1 - x0, step = span > 6 * 3600 ? 3600 : span > 2 * 3600 ? 1800 : 900;
        for (let t = Math.ceil(x0 / step) * step; t <= x1; t += step) c.fillText(new Date(t * 1000).toISOString().slice(11, 16), X(t), H - 6);
      }
      const grad = c.createLinearGradient(0, pt, 0, pt + h);
      grad.addColorStop(0, 'rgba(245,181,68,.35)'); grad.addColorStop(1, 'rgba(245,181,68,0)');
      c.beginPath(); c.moveTo(X(xs[0]), YA(0)); xs.forEach((x, i) => c.lineTo(X(x), YA(alt[i]))); c.lineTo(X(xs[xs.length - 1]), YA(0)); c.closePath();
      c.fillStyle = grad; c.fill();
      c.beginPath(); xs.forEach((x, i) => (i ? c.lineTo(X(x), YA(alt[i])) : c.moveTo(X(x), YA(alt[i])))); c.strokeStyle = '#f5b544'; c.lineWidth = 1.8; c.stroke();
      if (maxS > 1) { c.beginPath(); xs.forEach((x, i) => (i ? c.lineTo(X(x), YS(spd[i])) : c.moveTo(X(x), YS(spd[i])))); c.strokeStyle = 'rgba(92,200,255,.8)'; c.lineWidth = 1.2; c.stroke(); }
      if (hover >= 0) {
        const hx = X(xs[hover]);
        c.strokeStyle = 'rgba(230,236,247,.5)'; c.lineWidth = 1; c.beginPath(); c.moveTo(hx, pt); c.lineTo(hx, pt + h); c.stroke();
        const label = `${fmtInt(alt[hover])} ft${spd[hover] ? ' · ' + spd[hover] + ' kt' : ''}${hasTime ? ' · ' + new Date(xs[hover] * 1000).toISOString().slice(11, 16) + 'Z' : ''}`;
        c.font = '12px ' + css.getPropertyValue('--mono');
        const tw = c.measureText(label).width + 12, bx = Math.min(Math.max(pl, hx - tw / 2), W - pr - tw);
        c.fillStyle = 'rgba(24,37,62,.95)'; c.fillRect(bx, pt, tw, 20);
        c.fillStyle = '#e6ecf7'; c.textAlign = 'left'; c.fillText(label, bx + 6, pt + 14);
      }
      canvas._geom = { pl, w };
    }
    canvas.onmousemove = e => {
      const r = canvas.getBoundingClientRect(), g = canvas._geom;
      const v = x0 + ((e.clientX - r.left - g.pl) / g.w) * (x1 - x0);
      let best = 0, bd = Infinity; xs.forEach((x, i) => { const d = Math.abs(x - v); if (d < bd) { bd = d; best = i; } });
      hover = best; draw(); onHover(best);
    };
    canvas.onmouseleave = () => { hover = -1; draw(); };
    draw();
    new ResizeObserver(draw).observe(canvas);
  }

  /* ================= Formulaire ================= */
  function autocomplete(input, endpoint, render, onPick) {
    const wrap = input.parentElement;
    let list = null, items = [], hl = -1, t;
    const close = () => { list && list.remove(); list = null; hl = -1; };
    const show = () => {
      close(); if (!items.length) return;
      list = document.createElement('div'); list.className = 'ac-list';
      list.innerHTML = items.map((it, i) => `<div data-i="${i}">${render(it)}</div>`).join('');
      list.onmousedown = e => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); onPick(items[+d.dataset.i]); close(); } };
      wrap.appendChild(list);
    };
    input.addEventListener('input', () => {
      clearTimeout(t);
      const q = input.value.trim(); if (q.length < 2) return close();
      t = setTimeout(async () => { items = await api(`${endpoint}?q=${encodeURIComponent(q)}`); show(); }, 160);
    });
    input.addEventListener('keydown', e => {
      if (!list) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); hl = (hl + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        $$('[data-i]', list).forEach((d, i) => d.classList.toggle('hl', i === hl));
      } else if (e.key === 'Enter' && hl >= 0) { e.preventDefault(); onPick(items[hl]); close(); }
      else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
  }

  async function renderForm(id) {
    const f = id ? await api(`/api/flights/${id}`) : { role: state.role || 'passenger', date: new Date().toISOString().slice(0, 10) };
    let pendingTrack = null; // trace KML en attente (nouveau vol)
    const opt = (map, v) => `<option value=""></option>` + Object.entries(map).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('');
    const inp = (name, label, cls = '', extra = '') => `<div class="field ${cls}"><label for="f_${name}">${label}</label><input type="text" id="f_${name}" name="${name}" value="${esc(f[name] ?? '')}" ${extra}></div>`;
    view.innerHTML = `
      <div class="toolbar"><h1>${id ? `Modifier le vol ${esc(f.dep_code)} → ${esc(f.arr_code)}` : 'Nouveau vol'}</h1></div>
      <form class="form" autocomplete="off">
        <div>
          <section class="panel fieldset"><header><h2>Vol</h2>
            <div class="seg" id="roleSeg">${Object.entries(ROLE).map(([k, l]) => `<button type="button" data-v="${k}" class="${f.role === k ? 'on' : ''}">${l}</button>`).join('')}</div></header>
            <div class="body">
              <div class="field"><label for="f_date">Date de départ (locale)</label><input type="date" id="f_date" name="date" value="${esc(f.date || '')}" required></div>
              ${inp('flight_number', 'N° de vol', '', 'placeholder="AF1234" style="text-transform:uppercase"')}
              <div class="field span2"><label for="f_airline">Compagnie</label><input type="text" id="f_airline" placeholder="Rechercher : Air France, AF, AFR…" value="${esc(f.airline_name || f.airline_code || '')}">
                <input type="hidden" name="airline_code" value="${esc(f.airline_code || '')}"><input type="hidden" name="airline_name" value="${esc(f.airline_name || '')}">
                <div class="ac-sel" id="al_sel">${f.airline_code ? `Code ${esc(f.airline_code)}` : ''}</div></div>
              ${inp('callsign', 'Indicatif ATC', '', 'placeholder="AFR1234" style="text-transform:uppercase"')}
              <div class="field crew-only"><label for="f_crew_function">Fonction à bord</label><input type="text" id="f_crew_function" name="crew_function" list="crewfn" value="${esc(f.crew_function || '')}" placeholder="CCP, PNC, OPL…">
                <datalist id="crewfn"><option>CDB</option><option>OPL</option><option>CCP</option><option>CC</option><option>PNC</option><option>Hôtesse</option><option>Steward</option><option>Chef de cabine</option><option>Instructeur</option><option>Stagiaire</option><option>MEP</option></datalist></div>
              <div class="field"><label for="f_reason">Motif</label><select id="f_reason" name="reason">${opt(REASON, f.reason)}</select></div>
              <div class="field"><label>Note</label><div class="stars-input" id="stars">${[1, 2, 3, 4, 5].map(i => `<button type="button" data-v="${i}" class="${(f.rating || 0) >= i ? 'on' : ''}">★</button>`).join('')}</div><input type="hidden" name="rating" value="${esc(f.rating || '')}"></div>
            </div></section>

          <section class="panel fieldset"><header><h2>Trajet</h2><span class="dim" style="font-size:12px">Heures locales de chaque aéroport — la durée est calculée automatiquement</span></header>
            <div class="body">
              <div class="field span2"><label for="f_dep">Départ</label><input type="text" id="f_dep" name="dep_code" value="${esc(f.dep_code || '')}" placeholder="CDG, LFPG, Paris…" required style="text-transform:uppercase"><div class="ac-sel" id="dep_sel">${f.dep ? esc(f.dep.name + ', ' + f.dep.city) : ''}</div></div>
              <div class="field span2"><label for="f_arr">Arrivée</label><input type="text" id="f_arr" name="arr_code" value="${esc(f.arr_code || '')}" placeholder="NCE, LFMN, Nice…" required style="text-transform:uppercase"><div class="ac-sel" id="arr_sel">${f.arr ? esc(f.arr.name + ', ' + f.arr.city) : ''}</div></div>
              <div class="field"><label for="f_dts">Départ prévu</label><input type="time" id="f_dts" name="dep_time_sched" value="${esc(f.dep_time_sched || '')}"></div>
              <div class="field"><label for="f_dt">Départ réel</label><input type="time" id="f_dt" name="dep_time" value="${esc(f.dep_time || '')}"></div>
              <div class="field"><label for="f_ats">Arrivée prévue</label><input type="time" id="f_ats" name="arr_time_sched" value="${esc(f.arr_time_sched || '')}"></div>
              <div class="field"><label for="f_at">Arrivée réelle</label><input type="time" id="f_at" name="arr_time" value="${esc(f.arr_time || '')}"></div>
              <div class="field"><label for="f_ad">Date d'arrivée</label><input type="date" id="f_ad" name="arr_date" value="${esc(f.arr_date || '')}"><span class="hint">Si différente du départ</span></div>
              <div class="field"><label for="f_dur">Durée (min)</label><input type="number" id="f_dur" name="duration_min" value="${esc(f.duration_min ?? '')}" min="0"><span class="hint">Recalculée si heures saisies</span></div>
            </div></section>

          <section class="panel fieldset"><header><h2>Avion &amp; place</h2></header>
            <div class="body">
              <div class="field"><label for="f_type">Type (OACI)</label><input type="text" id="f_type" name="aircraft_type" value="${esc(f.aircraft_type || '')}" placeholder="A320, B77W…" style="text-transform:uppercase"></div>
              ${inp('aircraft_reg', 'Immatriculation', '', 'placeholder="F-HEPA" style="text-transform:uppercase"')}
              ${inp('aircraft_name', 'Modèle / nom', 'span2')}
              ${inp('seat', 'Siège', '', 'placeholder="23A"')}
              <div class="field"><label for="f_seat_type">Position</label><select id="f_seat_type" name="seat_type">${opt(SEAT, f.seat_type)}</select></div>
              <div class="field span2"><label for="f_cabin_class">Classe</label><select id="f_cabin_class" name="cabin_class">${opt(CLASS, f.cabin_class)}</select></div>
              <div class="field span4"><label for="f_notes">Notes</label><textarea id="f_notes" name="notes" rows="3">${esc(f.notes || '')}</textarea></div>
            </div></section>
          <div class="formbar"><a class="btn ghost" href="${id ? `#/flight/${id}` : '#/flights'}">Annuler</a><button class="btn primary" type="submit">${id ? 'Enregistrer' : 'Ajouter le vol'}</button></div>
        </div>
        <div class="sticky grid">
          <section class="panel"><header><h2>Trace Flightradar24</h2></header><div class="body">
            <label class="dropzone" id="drop">
              <svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>
              <div><b>Déposez un fichier KML</b> (ou CSV) Flightradar24</div>
              <div style="font-size:12px;margin-top:4px">${id ? 'La trace remplacera celle existante à l\'enregistrement' : 'Les champs vides seront pré-remplis : aéroports, date, heures, vol, durée'}</div>
              <input type="file" id="kml" accept=".kml,.csv,application/vnd.google-earth.kml+xml,text/csv" hidden>
            </label>
            <div id="trkinfo" class="muted" style="font-size:12px;margin-top:10px">${f.track ? `Trace existante : ${f.track.length} points` : ''}</div>
          </div><div id="mini" class="mini-map"></div></section>
        </div>
      </form>`;

    const form = $('form', view);
    const F = n => form.elements[n];
    const setRole = r => { f.role = r; $$('#roleSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === r)); $$('.crew-only').forEach(el => (el.style.display = r === 'passenger' ? 'none' : '')); };
    setRole(f.role || 'passenger');
    $('#roleSeg').onclick = e => { const b = e.target.closest('button'); if (b) setRole(b.dataset.v); };
    $('#stars').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      const v = F('rating').value == b.dataset.v ? '' : b.dataset.v; F('rating').value = v;
      $$('#stars button').forEach(x => x.classList.toggle('on', v && +x.dataset.v <= +v));
    };

    // Mini-carte de prévisualisation
    const mini = newMap($('#mini'), { minimal: true, flat: true });
    const ap = { dep: f.dep && f.dep.lat != null ? f.dep : null, arr: f.arr && f.arr.lat != null ? f.arr : null };
    const preview = () => {
      mini.clear();
      const pts = drawRoute(mini, { ...f, track: pendingTrack || f.track }, ap);
      if (pts.length) mini.fit(pts, { padding: 40, maxZoom: 8 });
      else if (ap.dep || ap.arr) mini.fit([ap.dep, ap.arr].filter(Boolean).map(a => [a.lat, a.lon]), { maxZoom: 6 });
      if (ap.dep) mini.label(ap.dep, '#4fd1a1');
      if (ap.arr) mini.label(ap.arr, '#ff8a65');
    };
    preview();

    const apRender = a => `<b>${esc(a.iata || a.icao)}</b><div>${esc(a.city)} – ${esc(a.name)}<br><span>${esc(a.icao || '')} · ${esc(a.country)}</span></div>`;
    for (const k of ['dep', 'arr']) {
      const input = $(`#f_${k}`);
      autocomplete(input, '/api/ref/airports', apRender, a => { input.value = a.iata || a.icao; ap[k] = a; $(`#${k}_sel`).textContent = `${a.name}, ${a.city}`; preview(); });
      input.addEventListener('change', async () => {
        const v = input.value.trim(); if (v.length < 3) return;
        try { const a = await api(`/api/ref/airport/${encodeURIComponent(v)}`); ap[k] = a; $(`#${k}_sel`).textContent = `${a.name}, ${a.city}`; preview(); }
        catch (_) { $(`#${k}_sel`).textContent = 'Aéroport inconnu dans la base (sera enregistré tel quel)'; }
      });
    }
    autocomplete($('#f_airline'), '/api/ref/airlines', a => `<b>${esc(a.iata || a.icao)}</b><div>${esc(a.name)}<br><span>${esc(a.icao || '')} · ${esc(a.country || '')}${a.active ? '' : ' · inactive'}</span></div>`, a => {
      $('#f_airline').value = a.name; F('airline_code').value = a.iata || a.icao; F('airline_name').value = a.name; $('#al_sel').textContent = `Code ${a.iata || a.icao}`;
      const fn = F('flight_number'); if (!fn.value && a.iata) fn.value = a.iata;
    });
    $('#f_airline').addEventListener('input', () => { F('airline_name').value = $('#f_airline').value; if (!$('#f_airline').value) { F('airline_code').value = ''; $('#al_sel').textContent = ''; } });
    autocomplete($('#f_type'), '/api/ref/aircraft', p => `<b>${esc(p.icao || p.iata)}</b><div>${esc(p.name)}</div>`, p => { $('#f_type').value = p.icao || p.iata; if (!F('aircraft_name').value) F('aircraft_name').value = p.name; });

    // Import KML dans le formulaire
    let dateTouched = false;
    F('date').addEventListener('input', () => (dateTouched = true));
    const handleFile = async file => {
      if (!file) return;
      $('#trkinfo').innerHTML = '<span class="spinner"></span> Analyse…';
      try {
        const r = await api('/api/track/parse', { method: 'POST', body: { filename: file.name, content: await readFile(file) } });
        pendingTrack = r.track; f._trackSource = r.source; f._trackKm = r.guess.track_distance_km;
        const g = r.guess, filled = [];
        const fill = (name, v, label) => { if (v != null && v !== '' && F(name) && !F(name).value) { F(name).value = v; filled.push(label); } };
        if (g.date && (!id && !dateTouched || !F('date').value)) { F('date').value = g.date; filled.push('date'); } fill('dep_code', g.dep_code, 'départ'); fill('arr_code', g.arr_code, 'arrivée');
        fill('dep_time', g.dep_time, 'heure départ'); fill('arr_time', g.arr_time, 'heure arrivée'); fill('arr_date', g.arr_date, 'date arrivée');
        fill('flight_number', g.flight_number, 'n° de vol'); fill('callsign', g.callsign, 'indicatif'); fill('aircraft_reg', g.aircraft_reg, 'immatriculation');
        fill('duration_min', g.duration_min, 'durée');
        if (g.airline_code && !F('airline_code').value) { F('airline_code').value = g.airline_code; F('airline_name').value = g.airline_name || ''; $('#f_airline').value = g.airline_name || g.airline_code; $('#al_sel').textContent = `Code ${g.airline_code}`; filled.push('compagnie'); }
        for (const k of ['dep', 'arr']) if (F(`${k}_code`).value) $(`#f_${k}`).dispatchEvent(new Event('change'));
        const t0 = r.track[0][3], t1 = r.track[r.track.length - 1][3];
        $('#trkinfo').innerHTML = `<span style="color:var(--ok)">✓ ${esc(file.name)}</span> — ${r.track.length} points, ${fmtInt(g.track_distance_km)} km parcourus` +
          (t0 && t1 ? `, ${new Date(t0 * 1000).toISOString().slice(11, 16)}Z → ${new Date(t1 * 1000).toISOString().slice(11, 16)}Z` : '') +
          (filled.length ? `<br>Pré-rempli : ${filled.join(', ')}` : '') +
          `<br><span class="dim">Les heures sont celles du 1er/dernier point (souvent roulage inclus) — ajustez si besoin.</span>`;
        preview();
      } catch (err) { $('#trkinfo').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
    };
    $('#kml').onchange = e => handleFile(e.target.files[0]);
    const drop = $('#drop');
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); handleFile(e.dataTransfer.files[0]); };

    form.onsubmit = async e => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form).entries());
      body.role = f.role;
      if (body.role === 'passenger') body.crew_function = '';
      if (pendingTrack) { body.track = pendingTrack; body.track_source = f._trackSource; body.track_distance_km = f._trackKm; }
      try {
        const saved = await api(id ? `/api/flights/${id}` : '/api/flights', { method: id ? 'PUT' : 'POST', body });
        toast(id ? 'Vol mis à jour' : 'Vol ajouté');
        location.hash = `#/flight/${saved.id}`;
      } catch (err) { toast(err.message, true); }
    };
  }

  /* ================= Statistiques ================= */
  async function renderStats() {
    const s = await api('/api/stats?' + qs());
    syncFilters(s.years);
    if (!s.totals.flights) { view.innerHTML = '<div class="empty"><h2>Pas encore de statistiques</h2><p>Aucun vol pour ces filtres.</p></div>'; return; }
    const rank = (list, n = 10, val = e => e.flights, fmt = v => fmtInt(v)) => {
      if (!list.length) return '<div class="dim">—</div>';
      const max = Math.max(1, ...list.slice(0, n).map(val));
      return `<ol class="rank">${list.slice(0, n).map(e => `<li><span class="lbl" title="${esc(e.label)}">${esc(e.label)}</span><span class="n">${fmt(val(e))}</span><span class="meter"><i style="width:${(val(e) / max) * 100}%"></i></span></li>`).join('')}</ol>`;
    };
    // Histogramme par année empilé par rôle (requête par rôle pour la ventilation)
    const byYearRole = state.role ? null : await Promise.all(['passenger', 'crew', 'deadhead'].map(r => api('/api/stats?' + qs({ role: r }))));
    const years = s.byYear.map(y => y.key);
    const maxY = Math.max(...s.byYear.map(y => y.flights));
    const bars = `<div class="bars">${s.byYear.map(y => {
      const parts = byYearRole ? ['passenger', 'crew', 'deadhead'].map((r, i) => [r, (byYearRole[i].byYear.find(x => x.key === y.key) || { flights: 0 }).flights]) : [[state.role, y.flights]];
      return `<div class="bar" title="${y.key} : ${y.flights} vols, ${fmtInt(y.km)} km, ${fmtDur(y.min)}"><div class="v">${y.flights}</div>
        <div class="stack" style="height:${(y.flights / maxY) * 150}px">${parts.filter(p => p[1]).map(([r, n]) => `<i style="flex:${n};background:${ROLE_COLOR[r]}"></i>`).join('')}</div>
        <div class="k">${years.length > 14 ? "'" + y.key.slice(2) : y.key}</div></div>`;
    }).join('')}</div>`;
    const months = Array.from({ length: 12 }, (_, i) => s.byMonth.find(m => +m.key === i + 1) || { key: String(i + 1), flights: 0 });
    const maxM = Math.max(1, ...months.map(m => m.flights));
    view.innerHTML = kpiHtml(s.totals) + `
      <div class="stats">
        <section class="panel wide"><header><h2>Vols par année</h2><div class="legend">${state.role ? '' : `<span><i style="background:${ROLE_COLOR.passenger}"></i>Passager</span><span><i style="background:${ROLE_COLOR.crew}"></i>Équipage</span><span><i style="background:${ROLE_COLOR.deadhead}"></i>MEP</span>`}</div></header><div class="body">${bars}</div></section>
        <section class="panel"><header><h2>Records</h2></header><div class="body records">
          ${s.longest ? `<a href="#/flight/${s.longest.id}"><span>Plus long</span><span class="mono">${esc(s.longest.route)} · ${fmtInt(s.longest.km)} km</span></a>` : ''}
          ${s.shortest ? `<a href="#/flight/${s.shortest.id}"><span>Plus court</span><span class="mono">${esc(s.shortest.route)} · ${fmtInt(s.shortest.km)} km</span></a>` : ''}
          <a><span>Distance moyenne</span><span class="mono">${fmtInt(s.totals.km / s.totals.flights)} km</span></a>
          <a><span>Distance Terre → Lune</span><span class="mono">${(s.totals.moon * 100).toFixed(1).replace('.', ',')} %</span></a>
          <a><span>Traces réelles</span><span class="mono">${fmtInt(s.totals.tracks)} / ${fmtInt(s.totals.flights)}</span></a>
        </div></section>
        <section class="panel"><header><h2>Aéroports</h2></header><div class="body">${rank(s.byAirport)}</div></section>
        <section class="panel"><header><h2>Compagnies</h2></header><div class="body">${rank(s.byAirline)}</div></section>
        <section class="panel"><header><h2>Liaisons</h2></header><div class="body">${rank(s.byRoute)}</div></section>
        <section class="panel"><header><h2>Types d'avion</h2></header><div class="body">${rank(s.byAircraft)}</div></section>
        <section class="panel"><header><h2>Immatriculations</h2></header><div class="body">${rank(s.byRegistration)}</div></section>
        <section class="panel"><header><h2>Pays</h2></header><div class="body">${rank(s.byCountry)}</div></section>
        <section class="panel"><header><h2>Saisonnalité</h2></header><div class="body"><div class="bars" style="height:150px">${months.map(m => `<div class="bar"><div class="v">${m.flights || ''}</div><div class="stack" style="height:${(m.flights / maxM) * 100}px;background:var(--accent);opacity:.75"></div><div class="k">${['jan','fév','mar','avr','mai','juin','juil','aoû','sep','oct','nov','déc'][+m.key - 1]}</div></div>`).join('')}</div></div></section>
        <section class="panel"><header><h2>Temps de vol par année</h2></header><div class="body">${rank([...s.byYear].reverse(), 12, e => e.min, v => fmtDur(v))}</div></section>
        <section class="panel"><header><h2>${s.byCrewFunction.length ? 'Fonctions à bord' : 'Rôles'}</h2></header><div class="body">${rank(s.byCrewFunction.length ? s.byCrewFunction : s.byRole.map(r => ({ ...r, label: ROLE[r.key] })))}</div></section>
        <section class="panel"><header><h2>Classes &amp; places</h2></header><div class="body">${rank([...s.byClass.map(c => ({ ...c, label: CLASS[c.key] || c.key })), ...s.bySeat.map(c => ({ ...c, label: SEAT[c.key] || c.key }))].sort((a, b) => b.flights - a.flights))}</div></section>
      </div>`;
  }

  /* ================= Données : import / export ================= */
  function renderData() {
    view.innerHTML = `
      <div class="toolbar"><h1>Données</h1>${state.meta && state.meta.authRequired ? '<button class="btn ghost" id="logout">Se déconnecter</button>' : ''}</div>
      <div class="data-grid">
        <section class="panel"><header><h2>Import groupé de traces KML</h2></header><div class="body">
          <p>Déposez plusieurs fichiers KML ou CSV Flightradar24 : un vol est créé pour chacun (aéroports, date, heures, n° de vol déduits de la trace).</p>
          <div class="field" style="margin-bottom:12px"><label>Rôle des vols créés</label><div class="seg" id="bulkRole">${Object.entries(ROLE).map(([k, l], i) => `<button type="button" data-v="${k}" class="${i ? '' : 'on'}">${l}</button>`).join('')}</div></div>
          <label class="dropzone" id="bulkDrop"><div><b>Déposer les fichiers KML</b></div><div style="font-size:12px">ou cliquer pour sélectionner</div><input type="file" id="bulk" accept=".kml,.csv" multiple hidden></label>
          <div class="log" id="bulkLog" hidden></div>
        </div></section>
        <section class="panel"><header><h2>Sauvegarde</h2></header><div class="body">
          <p>Export complet (traces incluses) au format JSON, réimportable dans AeroLog. Le CSV est pratique pour un tableur.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn primary" href="/api/export.json">Export JSON</a><a class="btn" href="/api/export.csv">Export CSV</a></div>
          <p style="margin-top:16px">La base SQLite se trouve aussi dans le volume <code>/data/aerolog.db</code>.</p>
        </div></section>
        <section class="panel"><header><h2>Importer des vols</h2></header><div class="body">
          <p><b>Export FlightLog</b> (menu Export → JSON ou XML), sauvegarde JSON AeroLog, ou CSV (virgule ou point-virgule). Colonnes CSV reconnues : <code>date</code>, <code>dep_code</code>, <code>arr_code</code> (obligatoires), <code>flight_number</code>, <code>airline_code</code>, <code>role</code>, <code>dep_time</code>, <code>arr_time</code>, <code>aircraft_type</code>, <code>aircraft_reg</code>, <code>seat</code>, <code>cabin_class</code>, <code>notes</code>…</p>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <select id="impMode"><option value="append">Ajouter aux vols existants</option><option value="replace">Remplacer tous les vols</option></select>
            <label class="btn">Choisir un fichier<input type="file" id="imp" accept=".json,.xml,.csv,text/csv,application/json,application/xml,text/xml" hidden></label></div>
          <div class="log" id="impLog" hidden></div>
        </div></section>
      </div>`;
    if ($('#logout')) $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); renderLogin(); };
    let bulkRole = 'passenger';
    $('#bulkRole').onclick = e => { const b = e.target.closest('button'); if (!b) return; bulkRole = b.dataset.v; $$('#bulkRole button').forEach(x => x.classList.toggle('on', x === b)); };
    const bulk = async files => {
      const log = $('#bulkLog'); log.hidden = false; log.innerHTML = '';
      const line = (cls, t) => { log.innerHTML += `<div class="${cls}">${esc(t)}</div>`; log.scrollTop = log.scrollHeight; };
      for (const file of files) {
        try {
          const content = await readFile(file);
          const r = await api('/api/track/parse', { method: 'POST', body: { filename: file.name, content } });
          const g = r.guess;
          if (!g.dep_code || !g.arr_code || !g.date) throw new Error('aéroport ou date non détecté — à saisir manuellement');
          const saved = await api('/api/flights', { method: 'POST', body: { ...g, role: bulkRole, track: r.track, track_source: r.source } });
          line('ok', `✓ ${file.name} → ${saved.date} ${saved.dep_code}→${saved.arr_code} ${saved.flight_number || ''}`);
        } catch (err) { line('err', `✗ ${file.name} : ${err.message}`); }
      }
      line('', 'Terminé.');
    };
    $('#bulk').onchange = e => bulk([...e.target.files]);
    const d = $('#bulkDrop');
    d.ondragover = e => { e.preventDefault(); d.classList.add('over'); };
    d.ondragleave = () => d.classList.remove('over');
    d.ondrop = e => { e.preventDefault(); d.classList.remove('over'); bulk([...e.dataTransfer.files]); };
    $('#imp').onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      const mode = $('#impMode').value;
      if (mode === 'replace' && !confirm('Tous les vols existants seront supprimés. Continuer ?')) return;
      const log = $('#impLog'); log.hidden = false; log.innerHTML = '<span class="spinner"></span>';
      try {
        const r = await api(`/api/import?mode=${mode}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: await readFile(file) });
        log.innerHTML = `<div class="ok">✓ ${r.imported} vol(s) importé(s)</div>` + r.errors.map(x => `<div class="err">${esc(x)}</div>`).join('') + (r.errorCount > r.errors.length ? `<div class="err">… ${r.errorCount - r.errors.length} autres erreurs</div>` : '');
      } catch (err) { log.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
      e.target.value = '';
    };
  }

  /* ================= Démarrage ================= */
  (async () => {
    syncFilters();
    state.meta = await (await fetch('/api/meta')).json();
    if (!state.meta.authed) return renderLogin();
    route();
  })();
})();
