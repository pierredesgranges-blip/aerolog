'use strict';
process.removeAllListeners('warning'); // masque l'avertissement "SQLite expérimental"
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, FIELDS } = require('./db');
const ref = require('./refdata');
const { haversineKm, localToUtc } = require('./geo');
const { parseTrackFile } = require('./track');
const pkg = require('../package.json');

const PORT = +process.env.PORT || 8080;
const PASSWORD = process.env.AEROLOG_PASSWORD || '';
const SECRET = process.env.AEROLOG_SECRET || (() => {
  const row = db.prepare("SELECT value FROM settings WHERE key='secret'").get();
  if (row) return row.value;
  const s = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO settings(key,value) VALUES('secret',?)").run(s);
  return s;
})();
const COOKIE = 'aerolog_session';
const SESSION_DAYS = 90;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '40mb' }));
app.use(express.text({ limit: '40mb', type: ['text/*', 'application/vnd.google-earth.kml+xml'] }));

/* ---------- Authentification (optionnelle, mot de passe unique) ---------- */
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(c => c[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
function isAuthed(req) {
  if (!PASSWORD) return true;
  const c = cookies(req)[COOKIE];
  if (!c) return false;
  const [exp, sig] = c.split('.');
  if (!exp || !sig || +exp < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
app.post('/api/login', (req, res) => {
  const pw = String((req.body && req.body.password) || '');
  const ok = PASSWORD && pw.length === PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(PASSWORD));
  if (!ok) return setTimeout(() => res.status(401).json({ error: 'Mot de passe incorrect' }), 600);
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});
app.get('/api/meta', (req, res) => res.json({ version: pkg.version, authRequired: !!PASSWORD, authed: isAuthed(req), mapStyle: process.env.AEROLOG_MAP_STYLE || 'dark' }));
app.get('/healthz', (req, res) => res.send('ok'));
app.use('/api', (req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: 'Non authentifié' })));

/* ---------- Helpers ---------- */
const apInfo = code => {
  const a = ref.airport(code);
  return a ? { code: a.iata || a.icao, iata: a.iata, icao: a.icao, name: a.name, city: a.city, country: a.country, lat: a.lat, lon: a.lon, tz: a.tz } : { code, name: code, city: '', country: '', lat: null, lon: null };
};
const clean = v => (v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? null : typeof v === 'string' ? v.trim() : v);

function normalize(input, existing = {}) {
  const f = { ...existing };
  for (const k of FIELDS) if (k in input) f[k] = clean(input[k]);
  if (Array.isArray(f.track)) f.track = JSON.stringify(f.track);
  for (const k of ['dep_code', 'arr_code', 'airline_code', 'aircraft_type', 'aircraft_reg', 'flight_number', 'callsign']) if (f[k]) f[k] = String(f[k]).toUpperCase();
  if (!f.date || !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) throw new Error('Date de départ invalide (AAAA-MM-JJ).');
  if (!f.dep_code || !f.arr_code) throw new Error('Aéroports de départ et d\'arrivée obligatoires.');
  if (!['passenger', 'crew', 'deadhead'].includes(f.role)) f.role = 'passenger';
  if (f.rating != null) f.rating = Math.max(0, Math.min(5, parseInt(f.rating, 10) || 0)) || null;

  const dep = ref.airport(f.dep_code), arr = ref.airport(f.arr_code);
  // Normalise sur le code IATA si connu
  if (dep && dep.iata) f.dep_code = dep.iata;
  if (arr && arr.iata) f.arr_code = arr.iata;
  if (f.airline_code && !f.airline_name) { const al = ref.airline(f.airline_code); if (al) f.airline_name = al.name; }
  if (f.aircraft_type && !f.aircraft_name) { const p = ref.plane(f.aircraft_type); if (p) f.aircraft_name = p.name; }
  if (f.flight_number && !f.airline_code) {
    const m = /^([A-Z0-9]{2})\d/.exec(f.flight_number);
    if (m && ref.airline(m[1])) { f.airline_code = m[1]; f.airline_name = f.airline_name || ref.airline(m[1]).name; }
  }

  f.distance_km = dep && arr ? Math.round(haversineKm(dep.lat, dep.lon, arr.lat, arr.lon)) : f.distance_km ?? null;

  // Durée : heures réelles, sinon programmées, sinon trace, sinon saisie manuelle
  const dt = f.dep_time || f.dep_time_sched, at = f.arr_time || f.arr_time_sched;
  let dur = null;
  if (dt && at && dep && arr) {
    const d0 = localToUtc(f.date, dt, dep);
    let d1 = localToUtc(f.arr_date || f.date, at, arr);
    if (d0 != null && d1 != null) {
      if (!f.arr_date) while (d1 <= d0) d1 += 864e5;
      dur = Math.round((d1 - d0) / 60000);
      if (dur <= 0 || dur > 30 * 60) dur = null;
    }
  }
  if (dur == null && f.track) {
    try {
      const t = JSON.parse(f.track);
      if (t.length > 1 && t[0][3] && t[t.length - 1][3]) dur = Math.round((t[t.length - 1][3] - t[0][3]) / 60);
    } catch (_) { /* trace illisible */ }
  }
  f.duration_min = dur ?? (input.duration_min != null ? parseInt(input.duration_min, 10) || null : existing.duration_min ?? null);
  return f;
}

function decorate(row, withTrack = false) {
  const o = { ...row, dep: apInfo(row.dep_code), arr: apInfo(row.arr_code), has_track: !!row.track };
  if (withTrack) o.track = row.track ? JSON.parse(row.track) : null; else delete o.track;
  return o;
}

function filterSql(q) {
  const where = [], args = [];
  if (q.year) { where.push("substr(date,1,4)=?"); args.push(String(q.year)); }
  if (q.role) { where.push('role=?'); args.push(q.role); }
  if (q.q) {
    where.push("(dep_code LIKE ? OR arr_code LIKE ? OR flight_number LIKE ? OR airline_name LIKE ? OR aircraft_reg LIKE ? OR aircraft_type LIKE ? OR notes LIKE ?)");
    for (let i = 0; i < 7; i++) args.push(`%${q.q}%`);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

const insertStmt = db.prepare(`INSERT INTO flights (${FIELDS.join(',')}) VALUES (${FIELDS.map(() => '?').join(',')})`);
const updateStmt = db.prepare(`UPDATE flights SET ${FIELDS.map(f => f + '=?').join(',')}, updated_at=datetime('now') WHERE id=?`);
const getStmt = db.prepare('SELECT * FROM flights WHERE id=?');
const insertFlight = f => Number(insertStmt.run(...FIELDS.map(k => f[k] ?? null)).lastInsertRowid);

const wrap = fn => (req, res) => { try { fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); } };

/* ---------- Vols ---------- */
app.get('/api/flights', wrap((req, res) => {
  const { sql, args } = filterSql(req.query);
  const cols = FIELDS.filter(f => f !== 'track').join(',');
  const rows = db.prepare(`SELECT id,${cols},created_at,updated_at,(track IS NOT NULL) AS has_track FROM flights ${sql} ORDER BY date DESC, COALESCE(dep_time,dep_time_sched,'') DESC, id DESC`).all(...args);
  res.json(rows.map(r => ({ ...decorate(r), has_track: !!r.has_track })));
}));
// Traces simplifiées pour la carte générale
app.get('/api/tracks', wrap((req, res) => {
  const { sql, args } = filterSql(req.query);
  const rows = db.prepare(`SELECT id,track FROM flights ${sql ? sql + ' AND' : 'WHERE'} track IS NOT NULL`).all(...args);
  res.json(rows.map(r => {
    const t = JSON.parse(r.track); const step = Math.max(1, Math.floor(t.length / 300));
    const s = t.filter((_, i) => i % step === 0); s.push(t[t.length - 1]);
    return { id: r.id, path: s.map(p => [p[0], p[1]]) };
  }));
}));
app.get('/api/flights/:id', wrap((req, res) => {
  const r = getStmt.get(+req.params.id);
  if (!r) return res.status(404).json({ error: 'Vol introuvable' });
  res.json(decorate(r, true));
}));
app.post('/api/flights', wrap((req, res) => {
  const id = insertFlight(normalize(req.body));
  res.status(201).json(decorate(getStmt.get(id), true));
}));
app.put('/api/flights/:id', wrap((req, res) => {
  const ex = getStmt.get(+req.params.id);
  if (!ex) return res.status(404).json({ error: 'Vol introuvable' });
  const f = normalize(req.body, ex);
  updateStmt.run(...FIELDS.map(k => f[k] ?? null), ex.id);
  res.json(decorate(getStmt.get(ex.id), true));
}));
app.delete('/api/flights/:id', wrap((req, res) => {
  db.prepare('DELETE FROM flights WHERE id=?').run(+req.params.id);
  res.json({ ok: true });
}));

/* ---------- Trajectoires ---------- */
const readUpload = req => {
  const b = req.body;
  if (typeof b === 'string') return { content: b, filename: String(req.query.filename || '') };
  if (b && typeof b.content === 'string') return { content: b.content, filename: String(b.filename || '') };
  throw new Error('Fichier manquant.');
};
app.post('/api/track/parse', wrap((req, res) => {
  const { content, filename } = readUpload(req);
  res.json(parseTrackFile(content, filename));
}));
app.put('/api/flights/:id/track', wrap((req, res) => {
  const ex = getStmt.get(+req.params.id);
  if (!ex) return res.status(404).json({ error: 'Vol introuvable' });
  const { content, filename } = readUpload(req);
  const p = parseTrackFile(content, filename);
  const f = normalize({ track: p.track, track_source: p.source, track_distance_km: p.guess.track_distance_km }, ex);
  updateStmt.run(...FIELDS.map(k => f[k] ?? null), ex.id);
  res.json({ flight: decorate(getStmt.get(ex.id), true), guess: p.guess });
}));
app.delete('/api/flights/:id/track', wrap((req, res) => {
  db.prepare("UPDATE flights SET track=NULL, track_source=NULL, track_distance_km=NULL, updated_at=datetime('now') WHERE id=?").run(+req.params.id);
  const ex = getStmt.get(+req.params.id);
  if (ex) { const f = normalize({}, ex); updateStmt.run(...FIELDS.map(k => f[k] ?? null), ex.id); }
  res.json(decorate(getStmt.get(+req.params.id), true));
}));

/* ---------- Référentiels ---------- */
const pickAp = a => ({ code: a.iata || a.icao, iata: a.iata, icao: a.icao, name: a.name, city: a.city, country: a.country, lat: a.lat, lon: a.lon });
app.get('/api/ref/airports', (req, res) => res.json(ref.searchAirports(req.query.q || '').map(pickAp)));
app.get('/api/ref/airport/:code', (req, res) => { const a = ref.airport(req.params.code); a ? res.json(pickAp(a)) : res.status(404).json({}); });
app.get('/api/ref/airlines', (req, res) => res.json(ref.searchAirlines(req.query.q || '').map(a => ({ code: a.iata || a.icao, iata: a.iata, icao: a.icao, name: a.name, country: a.country, active: a.active }))));
app.get('/api/ref/aircraft', (req, res) => res.json(ref.searchPlanes(req.query.q || '').map(p => ({ code: p.icao || p.iata, icao: p.icao, iata: p.iata, name: p.name }))));

/* ---------- Statistiques ---------- */
app.get('/api/stats', wrap((req, res) => {
  const { sql, args } = filterSql(req.query);
  const rows = db.prepare(`SELECT id,date,role,crew_function,airline_code,airline_name,dep_code,arr_code,aircraft_type,aircraft_name,aircraft_reg,cabin_class,seat_type,distance_km,duration_min,(track IS NOT NULL) AS has_track FROM flights ${sql}`).all(...args);
  const years = db.prepare("SELECT DISTINCT substr(date,1,4) AS y FROM flights ORDER BY y DESC").all().map(r => r.y);
  const count = (keyFn, labelFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r); if (!k) continue;
      const e = m.get(k) || { key: k, label: labelFn ? labelFn(r, k) : k, flights: 0, km: 0, min: 0 };
      e.flights++; e.km += r.distance_km || 0; e.min += r.duration_min || 0; m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.flights - a.flights || b.km - a.km);
  };
  const airportCounts = new Map();
  const countries = new Set();
  for (const r of rows) for (const c of [r.dep_code, r.arr_code]) {
    const a = apInfo(c);
    const e = airportCounts.get(c) || { key: c, label: a.city ? `${a.city} – ${a.name}` : c, country: a.country, lat: a.lat, lon: a.lon, flights: 0 };
    e.flights++; airportCounts.set(c, e);
    if (a.country) countries.add(a.country);
  }
  const km = rows.reduce((s, r) => s + (r.distance_km || 0), 0);
  const min = rows.reduce((s, r) => s + (r.duration_min || 0), 0);
  const longest = rows.reduce((b, r) => (!b || (r.distance_km || 0) > (b.distance_km || 0) ? r : b), null);
  const shortest = rows.filter(r => r.distance_km).reduce((b, r) => (!b || r.distance_km < b.distance_km ? r : b), null);
  res.json({
    years,
    totals: {
      flights: rows.length, km, min, airports: airportCounts.size, countries: countries.size,
      airlines: new Set(rows.map(r => r.airline_code).filter(Boolean)).size,
      aircraft: new Set(rows.map(r => r.aircraft_type).filter(Boolean)).size,
      registrations: new Set(rows.map(r => r.aircraft_reg).filter(Boolean)).size,
      tracks: rows.filter(r => r.has_track).length,
      earth: km / 40075, moon: km / 384400,
    },
    longest: longest && { id: longest.id, route: `${longest.dep_code} → ${longest.arr_code}`, km: longest.distance_km },
    shortest: shortest && { id: shortest.id, route: `${shortest.dep_code} → ${shortest.arr_code}`, km: shortest.distance_km },
    byYear: count(r => r.date.slice(0, 4)).sort((a, b) => a.key.localeCompare(b.key)),
    byMonth: count(r => r.date.slice(5, 7)).sort((a, b) => a.key.localeCompare(b.key)),
    byRole: count(r => r.role),
    byCrewFunction: count(r => (r.role === 'crew' ? r.crew_function || 'Non précisé' : null)),
    byAirline: count(r => r.airline_code, r => r.airline_name || r.airline_code),
    byAircraft: count(r => r.aircraft_type, r => r.aircraft_name || r.aircraft_type),
    byRegistration: count(r => r.aircraft_reg, r => `${r.aircraft_reg}${r.aircraft_type ? ' · ' + r.aircraft_type : ''}`),
    byRoute: count(r => [r.dep_code, r.arr_code].sort().join(' ⇄ ')),
    byClass: count(r => r.cabin_class),
    bySeat: count(r => r.seat_type),
    byAirport: [...airportCounts.values()].sort((a, b) => b.flights - a.flights),
    byCountry: (() => { const m = new Map(); for (const a of airportCounts.values()) if (a.country) m.set(a.country, (m.get(a.country) || 0) + a.flights); return [...m].map(([key, flights]) => ({ key, label: key, flights })).sort((a, b) => b.flights - a.flights); })(),
  });
}));

/* ---------- Import / export ---------- */
const CSV_COLS = FIELDS.filter(f => f !== 'track');
const csvEsc = v => (v == null ? '' : /[",;\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
app.get('/api/export.json', (req, res) => {
  const rows = db.prepare('SELECT * FROM flights ORDER BY date, id').all().map(r => ({ ...r, track: r.track ? JSON.parse(r.track) : null }));
  res.setHeader('Content-Disposition', `attachment; filename="aerolog-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ app: 'aerolog', version: pkg.version, exported_at: new Date().toISOString(), flights: rows });
});
app.get('/api/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM flights ORDER BY date, id').all();
  const out = [CSV_COLS.join(',')].concat(rows.map(r => CSV_COLS.map(c => csvEsc(r[c])).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="aerolog-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + out.join('\n'));
});

function parseCsvTable(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = text.replace(/^﻿/, '');
  const delim = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some(x => x !== '')) rows.push(row);
  const head = rows.shift().map(h => h.trim().toLowerCase());
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// Conversion d'un vol exporté par perdian/flightlog (export JSON ou XML)
const FL_CLASS = { ECONOMY: 'economy', PREMIUM_ECONOMY: 'premium', BUSINESS: 'business', FIRST: 'first' };
const FL_REASON = { PRIVATE: 'leisure', BUSINESS: 'business', CREW: 'work', VIRTUAL: 'other' };
const flDate = v => (Array.isArray(v) ? v.map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('-') : v ? String(v).slice(0, 10) : null);
const flTime = v => (Array.isArray(v) ? v.slice(0, 2).map(n => String(n).padStart(2, '0')).join(':') : v ? String(v).slice(0, 5) : null);
function fromFlightlog(it) {
  const airline = clean(it.airlineCode);
  let fn = clean(it.flightNumber);
  if (fn && airline && /^\d/.test(String(fn))) fn = airline + fn;
  let type = clean(it.aircraftType), name = clean(it.aircraftName);
  if (type && !/^[A-Z0-9]{2,4}$/i.test(type)) {
    const p = ref.searchPlanes(type)[0];
    if (!name) name = type;
    type = p ? p.icao || p.iata : null;
  }
  const date = flDate(it.departureDateLocal), arrDate = flDate(it.arrivalDateLocal);
  const dur = /^(\d+):(\d{2})$/.exec(String(it.flightDuration || ''));
  return {
    date, dep_code: it.departureAirportCode, arr_code: it.arrivalAirportCode,
    dep_time: flTime(it.departureTimeLocal), arr_time: flTime(it.arrivalTimeLocal),
    arr_date: arrDate && arrDate !== date ? arrDate : null,
    airline_code: airline, airline_name: clean(it.airlineName), flight_number: fn,
    aircraft_type: type, aircraft_name: name, aircraft_reg: clean(it.aircraftRegistration),
    cabin_class: FL_CLASS[it.cabinClass] || null, reason: FL_REASON[it.flightReason] || null,
    role: it.flightReason === 'CREW' ? 'crew' : 'passenger',
    seat: clean(it.seatNumber), seat_type: it.seatType ? String(it.seatType).toLowerCase() : null,
    notes: clean(it.comment), duration_min: dur ? +dur[1] * 60 + +dur[2] : null,
  };
}
function parseFlightlogXml(text) {
  const { XMLParser } = require('fast-xml-parser');
  const doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true }).parse(text);
  const root = doc['flights-exchange-package'] || doc.FlightsExchangePackage || Object.values(doc).find(v => v && typeof v === 'object');
  const fl = root && root.flights && root.flights.flight;
  if (!fl) throw new Error('XML non reconnu (export FlightLog attendu).');
  return Array.isArray(fl) ? fl : [fl];
}

app.post('/api/import', wrap((req, res) => {
  let list;
  const mode = req.query.mode === 'replace' ? 'replace' : 'append';
  if (typeof req.body === 'string') {
    const t = req.body.trim();
    list = t.startsWith('<') ? parseFlightlogXml(t) : t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : parseCsvTable(t);
  } else list = req.body;
  if (list && Array.isArray(list.flights)) list = list.flights;
  if (!Array.isArray(list)) throw new Error('Format non reconnu (JSON/XML FlightLog, JSON AeroLog ou CSV attendu).');
  const isFlightlog = list.some(it => it && ('departureAirportCode' in it || 'departureDateLocal' in it));
  if (isFlightlog) list = list.map(fromFlightlog);
  const errors = []; let imported = 0;
  db.exec('BEGIN');
  try {
    if (mode === 'replace') db.exec('DELETE FROM flights');
    list.forEach((it, i) => {
      try { insertFlight(normalize(it)); imported++; } catch (e) { errors.push(`Ligne ${i + 1} : ${e.message}`); }
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ imported, errors: errors.slice(0, 50), errorCount: errors.length });
}));

/* ---------- Frontend ---------- */
app.use('/vendor/maplibre', express.static(path.join(path.dirname(require.resolve('maplibre-gl/package.json')), 'dist'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, () => console.log(`AeroLog ${pkg.version} — http://0.0.0.0:${PORT}${PASSWORD ? ' (protégé par mot de passe)' : ''}`));
