// Import de trajectoires : KML Flightradar24 (Route / Trail), KML gx:Track, CSV Flightradar24
'use strict';
const { XMLParser } = require('fast-xml-parser');
const ref = require('./refdata');
const { utcToLocal, trackDistanceKm } = require('./geo');

const M_TO_FT = 3.28084;
const MAX_POINTS = 4000;

const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = v => (v == null ? '' : typeof v === 'object' ? (v['#text'] ?? '') : String(v)).toString().trim();

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => walk(n, fn)); return; }
  fn(node);
  for (const k of Object.keys(node)) if (typeof node[k] === 'object') walk(node[k], fn);
}

function parseCoord(s) {
  const [lon, lat, alt] = s.split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, altM: Number.isFinite(alt) ? alt : null } : null;
}

function parseKml(text) {
  const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: false, parseTagValue: false, trimValues: true });
  const doc = parser.parse(text);
  const kml = doc.kml || doc['kml:kml'] || doc;
  const document = kml.Document || kml;
  const meta = { name: txt(arr(document.name)[0]), description: txt(arr(document.description)[0]) };

  // 1) Placemarks ponctuels horodatés (dossier "Route" de FR24)
  const pts = [];
  walk(kml, n => {
    for (const pm of arr(n.Placemark)) {
      if (!pm || !pm.Point) continue;
      const c = parseCoord(txt(arr(pm.Point)[0].coordinates));
      if (!c) continue;
      const when = txt(pm.TimeStamp && pm.TimeStamp.when);
      const ts = when ? Date.parse(when) : NaN;
      const desc = txt(pm.description);
      const spd = /Speed:\s*<\/?[^>]*>?\s*([\d.]+)\s*kt/i.exec(desc) || /Speed[^\d]*([\d.]+)\s*kt/i.exec(desc);
      const altFt = /Altitude[^\d]*([\d,.]+)\s*ft/i.exec(desc);
      pts.push({
        lat: c.lat, lon: c.lon,
        alt: altFt ? Number(altFt[1].replace(/,/g, '')) : c.altM != null ? c.altM * M_TO_FT : null,
        ts: Number.isNaN(ts) ? null : ts / 1000,
        spd: spd ? Number(spd[1]) : null,
      });
    }
  });
  // Les Placemarks sont parfois imbriqués à plusieurs niveaux : on dédoublonne
  let points = dedupe(pts.filter(p => p.ts != null).sort((a, b) => a.ts - b.ts));

  // 2) gx:Track
  if (points.length < 2) {
    const tp = [];
    walk(kml, n => {
      for (const t of arr(n['gx:Track'])) {
        const whens = arr(t.when).map(txt);
        const coords = arr(t['gx:coord']).map(txt);
        coords.forEach((c, i) => {
          const [lon, lat, alt] = c.split(/\s+/).map(Number);
          const ts = Date.parse(whens[i]);
          if (Number.isFinite(lat)) tp.push({ lat, lon, alt: Number.isFinite(alt) ? alt * M_TO_FT : null, ts: Number.isNaN(ts) ? null : ts / 1000, spd: null });
        });
      }
    });
    if (tp.length >= 2) points = dedupe(tp);
  }

  // 3) LineString (dossier "Trail") — sans horodatage
  if (points.length < 2) {
    const lp = [];
    walk(kml, n => {
      for (const ls of arr(n.LineString)) {
        for (const s of txt(ls.coordinates).split(/\s+/)) {
          const c = parseCoord(s);
          if (c) lp.push({ lat: c.lat, lon: c.lon, alt: c.altM != null ? c.altM * M_TO_FT : null, ts: null, spd: null });
        }
      }
    });
    points = dedupe(lp);
  }
  return { points, meta };
}

function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',' || c === ';') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// CSV FR24 : Timestamp,UTC,Callsign,Position,Altitude,Speed,Direction
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const head = splitCsvLine(lines.shift() || '').map(h => h.toLowerCase());
  const idx = k => head.findIndex(h => h.includes(k));
  const iTs = idx('timestamp'), iUtc = idx('utc'), iCs = idx('callsign'), iPos = idx('position');
  const iLat = idx('lat'), iLon = head.findIndex(h => h.startsWith('lon') || h === 'lng');
  const iAlt = idx('alt'), iSpd = idx('speed');
  let callsign = '';
  const points = [];
  for (const l of lines) {
    const c = splitCsvLine(l);
    let lat, lon;
    if (iPos >= 0) [lat, lon] = c[iPos].split(',').map(Number);
    else { lat = +c[iLat]; lon = +c[iLon]; }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    let ts = iTs >= 0 && /^\d+$/.test(c[iTs]) ? +c[iTs] : iUtc >= 0 ? Date.parse(c[iUtc]) / 1000 : null;
    if (Number.isNaN(ts)) ts = null;
    if (!callsign && iCs >= 0) callsign = c[iCs];
    points.push({ lat, lon, alt: iAlt >= 0 ? +c[iAlt] || 0 : null, ts, spd: iSpd >= 0 ? +c[iSpd] || null : null });
  }
  return { points: dedupe(points.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))), meta: { name: callsign } };
}

function dedupe(points) {
  const out = [];
  for (const p of points) {
    const l = out[out.length - 1];
    if (l && l.lat === p.lat && l.lon === p.lon && l.ts === p.ts) continue;
    out.push(p);
  }
  return out;
}

function downsample(points) {
  if (points.length <= MAX_POINTS) return points;
  const step = points.length / MAX_POINTS;
  const out = [];
  for (let i = 0; i < MAX_POINTS - 1; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

function parseTrackFile(text, filename = '') {
  const isXml = /^\s*(<\?xml|<kml)/i.test(text) || /\.kml$/i.test(filename);
  const { points, meta } = isXml ? parseKml(text) : parseCsv(text);
  if (points.length < 2) throw new Error('Aucune trajectoire exploitable trouvée dans le fichier.');
  const pts = downsample(points);
  const track = pts.map(p => [
    +p.lat.toFixed(5), +p.lon.toFixed(5),
    p.alt != null ? Math.round(p.alt) : null,
    p.ts != null ? Math.round(p.ts) : null,
    p.spd != null ? Math.round(p.spd) : null,
  ]);
  return { track, guess: guessFlight(track, meta, filename), source: isXml ? 'kml' : 'csv' };
}

// Déduit les infos du vol à partir de la trace et du nom FR24 (ex. "AF1234/AFR1234")
function guessFlight(track, meta, filename) {
  const first = track[0], last = track[track.length - 1];
  const dep = ref.nearestAirport(first[0], first[1]);
  const arr = ref.nearestAirport(last[0], last[1]);
  const g = { dep_code: dep ? dep.iata || dep.icao : null, arr_code: arr ? arr.iata || arr.icao : null };

  // Décollage / atterrissage : premier/dernier point en vol si l'altitude est connue, sinon extrémités
  const t0 = first[3], t1 = last[3];
  if (t0 != null) {
    const l = utcToLocal(t0 * 1000, dep);
    g.date = l.date; g.dep_time = l.time;
  }
  if (t1 != null) {
    const l = utcToLocal(t1 * 1000, arr);
    g.arr_time = l.time;
    if (g.date && l.date !== g.date) g.arr_date = l.date;
  }
  if (t0 != null && t1 != null) g.duration_min = Math.round((t1 - t0) / 60);

  const label = `${meta.name || ''} ${filename.replace(/\.(kml|csv)$/i, '')}`;
  const m = /\b([A-Z0-9]{2})(\d{1,4}[A-Z]?)\s*\/\s*([A-Z]{3}\d{1,4}[A-Z]{0,2})\b/i.exec(label);
  if (m) {
    g.airline_code = m[1].toUpperCase(); g.flight_number = m[1].toUpperCase() + m[2]; g.callsign = m[3].toUpperCase();
  } else {
    const c = /\b([A-Z]{3})(\d{1,4}[A-Z]{0,2})\b/.exec(label.toUpperCase());
    const f = /\b([A-Z0-9]{2})(\d{1,4}[A-Z]?)\b/.exec(label.toUpperCase());
    if (c && ref.airline(c[1])) { g.callsign = c[0]; const al = ref.airline(c[1]); g.airline_code = al.iata || al.icao; }
    else if (f && ref.airline(f[1])) { g.flight_number = f[0]; g.airline_code = f[1]; }
  }
  const al = ref.airline(g.airline_code) || (g.callsign && ref.airline(g.callsign.slice(0, 3)));
  if (al) { g.airline_name = al.name; g.airline_code = al.iata || al.icao; }
  // Immatriculation éventuelle dans la description (ex. "F-HPJA")
  const reg = /\b([A-Z]{1,2}-[A-Z0-9]{3,5}|N\d{1,5}[A-Z]{0,2})\b/.exec(meta.description || '');
  if (reg) g.aircraft_reg = reg[1];
  g.track_distance_km = Math.round(trackDistanceKm(track));
  return g;
}

module.exports = { parseTrackFile };
