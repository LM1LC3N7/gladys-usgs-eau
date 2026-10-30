// -----------------------------------------------------------------------------
// The configuration typed in Gladys (manifest `config_schema`), normalized so
// that the rest of the code never sees `undefined` nor a value out of bounds.
// Nothing secret: the USGS data is open, without account nor key.
// -----------------------------------------------------------------------------

import {
  INTERVAL_DEFAULT_MIN,
  INTERVAL_MAX_MIN,
  INTERVAL_MIN_MIN,
  MAX_AGE_DEFAULT_H,
  MAX_AGE_MAX_H,
  MAX_AGE_MIN_H,
  MAX_STATIONS,
} from './constants.js';

/** Defaults: the same as the `default` values of the manifest. */
export const DEFAULT_CONFIG = {
  stations: '',
  units: 'us',
  language: 'en',
  interval_minutes: INTERVAL_DEFAULT_MIN,
  max_age_hours: MAX_AGE_DEFAULT_H,
};

export const LANGUAGES = ['en', 'fr'];
export const UNIT_SYSTEMS = ['us', 'metric'];

/** A monitoring location id: an agency code, a hyphen, a site number of 8 to 15 digits. */
export const STATION_ID = /^[A-Z0-9]{1,5}-[0-9]{8,15}$/;

/**
 * One entry typed by the user -> a monitoring location id, else undefined.
 * "01646500" -> "USGS-01646500"; "usgs-01646500" and "AR008-343826091361301"
 * are kept (agency upper-cased).
 */
export function stationIdOf(entry) {
  const text = String(entry ?? '').trim();
  if (/^[0-9]{8,15}$/.test(text)) return `USGS-${text}`;
  const id = text.toUpperCase();
  return STATION_ID.test(id) ? id : undefined;
}

/**
 * The station field -> the ids (in the order typed, without duplicates, at
 * most MAX_STATIONS), the number of entries refused and whether some were cut.
 */
export function parseStations(text) {
  const ids = [];
  let invalid = 0;
  let cut = false;
  const entries =
    typeof text === 'string' || typeof text === 'number' ? String(text).split(/[\s,;]+/) : [];
  for (const entry of entries.slice(0, 200)) {
    if (entry === '') continue;
    const id = stationIdOf(entry);
    if (!id) {
      invalid += 1;
    } else if (!ids.includes(id)) {
      if (ids.length < MAX_STATIONS) ids.push(id);
      else cut = true;
    }
  }
  if (entries.length > 200) cut = true;
  return { ids, invalid, cut };
}

/** A whole number typed in the form: '' or null is "not typed", a decimal or a text is refused. */
function integer(typed, { min, max, fallback }, note, notes) {
  if (typed === undefined || typed === null || typed === '') return fallback;
  const value = typeof typed === 'number' ? typed : /^\d{1,4}$/.test(`${typed}`) ? +typed : NaN;
  if (Number.isInteger(value) && value >= min && value <= max) return value;
  notes.push(note);
  if (Number.isInteger(value) && value > max) return max;
  if (Number.isInteger(value) && value >= 0) return min;
  return fallback;
}

/**
 * @returns {{ stations: string[], units: 'us'|'metric', language: 'en'|'fr',
 *   intervalMinutes: number, maxAgeHours: number, notes: string[] }}
 * `notes` lists the values replaced or refused (shown in the status, never the value typed).
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const notes = [];
  const pick = (key, list) => {
    const value = source[key];
    if (value === undefined || value === null || value === '') return DEFAULT_CONFIG[key];
    if (list.includes(value)) return value;
    notes.push(key);
    return DEFAULT_CONFIG[key];
  };
  const { ids, invalid, cut } = parseStations(source.stations ?? DEFAULT_CONFIG.stations);
  if (invalid > 0) notes.push('stations_invalid');
  if (cut) notes.push('stations_cut');
  return {
    stations: ids,
    units: pick('units', UNIT_SYSTEMS),
    language: pick('language', LANGUAGES),
    intervalMinutes: integer(
      source.interval_minutes,
      { min: INTERVAL_MIN_MIN, max: INTERVAL_MAX_MIN, fallback: INTERVAL_DEFAULT_MIN },
      'interval',
      notes,
    ),
    maxAgeHours: integer(
      source.max_age_hours,
      { min: MAX_AGE_MIN_H, max: MAX_AGE_MAX_H, fallback: MAX_AGE_DEFAULT_H },
      'max_age',
      notes,
    ),
    notes,
  };
}
