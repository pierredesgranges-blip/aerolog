// Référentiels aéroports / compagnies / avions (données OpenFlights, licence ODbL)
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AEROLOG_REFDATA_DIR || path.join(__dirname, '..', 'data');

function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(v => (v === '\\N' || v === '-' ? '' : v));
}

function readDat(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map(parseCsvLine);
}

const airports = [];
const byIata = new Map();
const byIcao = new Map();
for (const r of readDat('airports.dat')) {
  const a = {
    name: r[1], city: r[2], country: r[3], iata: r[4], icao: r[5],
    lat: +r[6], lon: +r[7], alt: +r[8] || 0,
    utcOffset: r[9] === '' ? null : +r[9], tz: r[11] || null,
  };
  if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
  airports.push(a);
  if (a.iata && !byIata.has(a.iata)) byIata.set(a.iata, a);
  if (a.icao && !byIcao.has(a.icao)) byIcao.set(a.icao, a);
}

const airlines = [];
const alByIata = new Map();
const alByIcao = new Map();
for (const r of readDat('airlines.dat')) {
  const a = { name: r[1], iata: r[3], icao: r[4], callsign: r[5], country: r[6], active: r[7] === 'Y' };
  if (!a.name || (!a.iata && !a.icao)) continue;
  airlines.push(a);
  // on privilégie les compagnies actives pour les codes partagés
  if (a.iata && (!alByIata.has(a.iata) || (a.active && !alByIata.get(a.iata).active))) alByIata.set(a.iata, a);
  if (a.icao && (!alByIcao.has(a.icao) || (a.active && !alByIcao.get(a.icao).active))) alByIcao.set(a.icao, a);
}

const planes = readDat('planes.dat').map(r => ({ name: r[0], iata: r[1], icao: r[2] })).filter(p => p.name);
const plByIcao = new Map(planes.filter(p => p.icao).map(p => [p.icao, p]));
const plByIata = new Map(planes.filter(p => p.iata).map(p => [p.iata, p]));

function airport(code) {
  if (!code) return null;
  code = String(code).trim().toUpperCase();
  return (code.length === 3 ? byIata.get(code) : byIcao.get(code)) || byIata.get(code) || byIcao.get(code) || null;
}
function airline(code) {
  if (!code) return null;
  code = String(code).trim().toUpperCase();
  return (code.length === 3 ? alByIcao.get(code) : alByIata.get(code)) || null;
}
function plane(code) {
  if (!code) return null;
  code = String(code).trim().toUpperCase();
  return plByIcao.get(code) || plByIata.get(code) || null;
}

const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function search(list, q, fields, codeFields, limit = 12) {
  q = norm(q).trim();
  if (!q) return [];
  const Q = q.toUpperCase();
  const scored = [];
  for (const it of list) {
    let s = 0;
    for (const f of codeFields) if (it[f] && it[f] === Q) s = Math.max(s, 100);
    for (const f of codeFields) if (!s && it[f] && it[f].startsWith(Q)) s = Math.max(s, 50);
    if (!s) for (const f of fields) {
      const v = norm(it[f]);
      if (v.startsWith(q)) { s = Math.max(s, 30); break; }
      if (v.includes(q)) s = Math.max(s, 10);
    }
    if (s) scored.push([s + (it.iata ? 2 : 0) + (it.active ? 3 : 0), it]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(x => x[1]);
}

function nearestAirport(lat, lon, maxKm = 15) {
  const { haversineKm } = require('./geo');
  let best = null, bd = Infinity;
  for (const a of airports) {
    if (Math.abs(a.lat - lat) > 0.5) continue;
    const d = haversineKm(lat, lon, a.lat, a.lon);
    // léger bonus aux aéroports avec code IATA (aéroports commerciaux)
    const eff = a.iata ? d : d + 3;
    if (eff < bd) { bd = eff; best = a; }
  }
  return best && bd <= maxKm ? best : null;
}

module.exports = {
  airports, airlines, planes, airport, airline, plane, nearestAirport,
  searchAirports: q => search(airports, q, ['city', 'name', 'country'], ['iata', 'icao']),
  searchAirlines: q => search(airlines, q, ['name', 'callsign'], ['iata', 'icao']),
  searchPlanes: q => search(planes, q, ['name'], ['icao', 'iata']),
};
