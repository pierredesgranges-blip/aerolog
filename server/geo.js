'use strict';
const R = 6371.0088;
const rad = d => (d * Math.PI) / 180;

function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function trackDistanceKm(track) {
  let d = 0;
  for (let i = 1; i < track.length; i++) d += haversineKm(track[i - 1][0], track[i - 1][1], track[i][0], track[i][1]);
  return d;
}

// Décalage (minutes) d'un fuseau IANA à un instant donné
function tzOffsetMin(tz, ts) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ts / 1000) * 1000) / 60000);
}

function offsetFor(ap, ts) {
  if (ap && ap.tz) { try { return tzOffsetMin(ap.tz, ts); } catch (_) { /* fuseau inconnu */ } }
  if (ap && ap.utcOffset != null) return Math.round(ap.utcOffset * 60);
  return 0;
}

// Heure locale (YYYY-MM-DD + HH:MM) → timestamp UTC (ms)
function localToUtc(date, time, ap) {
  if (!date || !time) return null;
  const guess = Date.parse(`${date}T${time.length === 5 ? time : time.slice(0, 5)}:00Z`);
  if (Number.isNaN(guess)) return null;
  let off = offsetFor(ap, guess);
  let ts = guess - off * 60000;
  const off2 = offsetFor(ap, ts);
  if (off2 !== off) ts = guess - off2 * 60000;
  return ts;
}

function utcToLocal(ts, ap) {
  const d = new Date(ts + offsetFor(ap, ts) * 60000);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

module.exports = { haversineKm, trackDistanceKm, localToUtc, utcToLocal, offsetFor };
