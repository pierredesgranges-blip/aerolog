'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.AEROLOG_DATA_DIR || path.join(__dirname, '..', 'var');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'aerolog.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS flights (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,            -- date de départ (locale)
  role            TEXT NOT NULL DEFAULT 'passenger', -- passenger | crew | deadhead
  crew_function   TEXT,                     -- CDB, OPL, CCP, PNC, Hôtesse/Steward...
  airline_code    TEXT,
  airline_name    TEXT,
  flight_number   TEXT,
  callsign        TEXT,
  dep_code        TEXT NOT NULL,
  arr_code        TEXT NOT NULL,
  dep_time_sched  TEXT,
  dep_time        TEXT,                     -- heure réelle (locale) HH:MM
  arr_date        TEXT,                     -- date d'arrivée (locale) si différente
  arr_time_sched  TEXT,
  arr_time        TEXT,
  aircraft_type   TEXT,                     -- code OACI (A320, B77W...)
  aircraft_reg    TEXT,
  aircraft_name   TEXT,
  seat            TEXT,
  seat_type       TEXT,                     -- window | middle | aisle | jumpseat | crewrest
  cabin_class     TEXT,                     -- economy | premium | business | first | crew
  reason          TEXT,                     -- leisure | business | work | other
  rating          INTEGER,
  notes           TEXT,
  distance_km     REAL,
  duration_min    INTEGER,
  track           TEXT,                     -- JSON [[lat,lon,alt_ft,epoch_s,speed_kt],...]
  track_source    TEXT,
  track_distance_km REAL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_flights_date ON flights(date);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// Migrations légères : ajoute les colonnes manquantes si le schéma évolue
const existing = new Set(db.prepare('PRAGMA table_info(flights)').all().map(c => c.name));
for (const [col, type] of [['callsign', 'TEXT'], ['rating', 'INTEGER'], ['track_distance_km', 'REAL']]) {
  if (!existing.has(col)) db.exec(`ALTER TABLE flights ADD COLUMN ${col} ${type}`);
}

const FIELDS = [
  'date', 'role', 'crew_function', 'airline_code', 'airline_name', 'flight_number', 'callsign',
  'dep_code', 'arr_code', 'dep_time_sched', 'dep_time', 'arr_date', 'arr_time_sched', 'arr_time',
  'aircraft_type', 'aircraft_reg', 'aircraft_name', 'seat', 'seat_type', 'cabin_class', 'reason',
  'rating', 'notes', 'distance_km', 'duration_min', 'track', 'track_source', 'track_distance_km',
];

module.exports = { db, FIELDS, DATA_DIR };
