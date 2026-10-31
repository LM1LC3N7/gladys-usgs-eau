// -----------------------------------------------------------------------------
// The answers of the USGS Water Data OGC APIs -> plain data (pure: no clock,
// no network). Everything read from the network is data, never a key: the
// station ids are checked against the ones asked, every lookup goes through a
// Map, the texts are cleaned and bounded.
//
// latest-continuous: one feature per time series of a station, with its
// latest value: { time_series_id, monitoring_location_id, parameter_code,
// statistic_id, time (ISO 8601 with offset), value (a STRING, or null when
// the station gives none: dry well, ice, equipment...), unit_of_measure,
// qualifier (null or a list of codes such as "ICE", "DRY"; a number may come
// with a code that invalidates it), approval_status }. A station can
// have several series of one parameter (a sensor replaced in 2019, two
// depths): the choice is made by `selectSeries`.
// -----------------------------------------------------------------------------

import { INSTANTANEOUS, PAGE_LIMIT, PARAMETERS } from './constants.js';
import { STATION_ID } from './config.js';

export class FormatError extends Error {
  constructor(reason) {
    super(`unexpected format: ${reason}`);
    this.name = 'FormatError';
  }
}

const VALUE_PROPERTIES = [
  'time_series_id',
  'monitoring_location_id',
  'parameter_code',
  'statistic_id',
  'time',
  'value',
  'unit_of_measure',
  'qualifier',
  'approval_status',
];

/** The URL of the latest values of these stations (one request for all of them). */
export function latestUrl(base, ids) {
  const query = new URLSearchParams({
    f: 'json',
    limit: String(PAGE_LIMIT),
    skipGeometry: 'true',
    monitoring_location_id: ids.join(','),
    parameter_code: Object.keys(PARAMETERS).join(','),
    properties: VALUE_PROPERTIES.join(','),
  });
  return `${base}/collections/latest-continuous/items?${query}`;
}

/** The URL of the description (name, time zone) of these stations. */
export function locationsUrl(base, ids) {
  const query = new URLSearchParams({
    f: 'json',
    limit: '100',
    skipGeometry: 'true',
    id: ids.join(','),
    properties:
      'monitoring_location_name,site_type,state_name,time_zone_abbreviation,uses_daylight_savings',
  });
  return `${base}/collections/monitoring-locations/items?${query}`;
}

/**
 * The words typed in the search -> upper-case words of letters and digits
 * only (nothing else ever reaches the CQL filter), at most 4 of 2 to 30 characters.
 */
export function searchWords(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((word) => word.length >= 2)
    .map((word) => word.slice(0, 30))
    .slice(0, 4);
}

/** The URL of a search by name: every word in the name (CQL2 text, words checked by searchWords). */
export function searchUrl(base, words, limit) {
  const filter = words.map((w) => `monitoring_location_name LIKE '%${w}%'`).join(' AND ');
  const query = new URLSearchParams({
    f: 'json',
    limit: String(limit),
    skipGeometry: 'true',
    properties: 'monitoring_location_name,site_type,state_name',
    'filter-lang': 'cql2-text',
    filter,
  });
  return `${base}/collections/monitoring-locations/items?${query}`;
}

/** A printable string: control characters removed, spaces folded, bounded; '' otherwise. */
export function cleanText(value, max = 100) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    out += code < 0x20 || (code >= 0x7f && code < 0xa0) ? ' ' : char;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/** A strict ISO 8601 instant with its offset -> epoch ms; anything else (no offset, Feb 30) -> undefined. */
export function parseInstant(text) {
  if (typeof text !== 'string') return undefined;
  const m = ISO.exec(text);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return undefined;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(utc);
  if (check.getUTCDate() !== d || check.getUTCMonth() !== mo - 1) return undefined;
  if (m[7] === 'Z') return utc;
  const oh = Number(m[9]);
  const om = Number(m[10]);
  if (oh > 14 || om > 59) return undefined;
  const offset = (oh * 60 + om) * 60_000 * (m[8] === '-' ? -1 : 1);
  return utc - offset;
}

/** A value of the source: a plain decimal string or a finite number; null stays null; else undefined. */
export function parseValue(value) {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?[0-9]{1,9}(\.[0-9]{1,6})?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

/** The units the source gives, per kind -> our canonical unit (cfs, ft, °C). */
const SOURCE_UNITS = {
  discharge: { 'ft^3/s': 'cfs', 'ft3/s': 'cfs', 'm^3/s': 'cms', 'm3/s': 'cms' },
  'gage-height': { ft: 'ft', m: 'm' },
  'groundwater-depth': { ft: 'ft', m: 'm' },
  'water-temperature': { degC: 'degC', 'deg C': 'degC', degF: 'degF', 'deg F': 'degF' },
};

/** Exact factors: 1 ft = 0.3048 m (international foot), 1 ft³/s = 0.3048³ m³/s. */
export const FOOT = 0.3048;
export const CUBIC_FOOT = 0.028316846592;

/** A value in a source unit -> the canonical unit of its kind (cfs, ft, °C). */
function canonical(unit, value) {
  switch (unit) {
    case 'cms':
      return value / CUBIC_FOOT;
    case 'm':
      return value / FOOT;
    case 'degF':
      return ((value - 32) * 5) / 9;
    default:
      return value;
  }
}

/** The plausible range of each kind, in the canonical unit: a value outside is not a measurement. */
export const BOUNDS = {
  discharge: [-500_000, 10_000_000],
  'gage-height': [-500, 20_000],
  'groundwater-depth': [-1_000, 10_000],
  'water-temperature': [-5, 50],
};

/**
 * The qualifier codes the USGS sends with a value (seen on the real service,
 * every series of the four parameters, 2026-10-30: test/fixtures/qualifiers.json).
 * Those that only NUANCE a value: the value is a measurement, published, and
 * the status says the code. Every other code (DRY, ICE, EQUIP, MAINT, UNAVAIL,
 * TEST, DISCONTINUED, SEASONAL, FLOOD, DAMFAILURE, ZEROFLOW, LESSTHAN,
 * GREATERTHAN, BLWMIN, GHNOTASSCPKQ, and any code not listed here) INVALIDATES
 * it: never published, the status says why. A bound ("less than", "below the
 * minimum") is not a measurement; a dry well's number is the depth of its
 * sensor, not of water; an unknown code is taken as the worst.
 */
export const NUANCING = new Set([
  'ESTIMATED',
  'REVISED',
  'BACKWATER',
  'REGULATED',
  'DEBRIS',
  'DIFFDATUM',
  'RATINGDEV',
  'TIDE',
  'URBAN',
  'OTHERAGENCY',
  'OPPORTUNISTIC',
  'FORCEINTERPOLATION',
]);

/**
 * The qualifier field (a list of codes, or one code as a plain string) ->
 * { codes (upper-case letters, digits and `_`, at most 24 characters, 8 at
 * most), blocked: whether any entry, readable or not, invalidates the value }.
 */
export function qualifiersOf(field) {
  const none =
    field === null || field === undefined || (typeof field === 'string' && !field.trim());
  if (none) return { codes: [], blocked: false };
  const list = typeof field === 'string' ? [field] : Array.isArray(field) ? field : undefined;
  // Neither a list nor a code (a number, an object): no proof the value is good.
  if (!list) return { codes: [], blocked: true };
  const codes = [];
  let blocked = false;
  for (const item of list.slice(0, 32)) {
    const code = typeof item === 'string' ? item.trim().toUpperCase() : '';
    if (!/^[A-Z0-9_]{1,24}$/.test(code)) {
      // An entry that cannot be read is no proof the value is good.
      blocked = true;
      continue;
    }
    if (!NUANCING.has(code)) blocked = true;
    if (!codes.includes(code) && codes.length < 8) codes.push(code);
  }
  if (list.length > 32) blocked = true;
  return { codes, blocked };
}

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * One page of latest-continuous -> the series of the stations asked.
 * @param {string} text the JSON answer
 * @param {Set<string>} asked the station ids asked
 * @returns {{ series: Array<{ station: string, kind: string, tsid: string, time?: number,
 *   value?: number|null, qualifiers: string[], blocked: boolean, provisional: boolean }>,
 *   total: number, ignored: number, next?: string }}
 *   `blocked`: a qualifier invalidates the value (see NUANCING); `provisional`: not
 *   (yet) approved by the USGS.
 *   `value` in the canonical unit (cfs, ft, °C); undefined when unreadable (unknown
 *   unit, a text, out of range), null when the source gives none.
 * Throws a FormatError when the envelope is not a feature collection.
 */
export function parseLatest(text, asked) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new FormatError('not JSON');
  }
  if (!isPlain(body) || body.type !== 'FeatureCollection' || !Array.isArray(body.features)) {
    throw new FormatError('not a feature collection');
  }
  if (body.features.length > PAGE_LIMIT) throw new FormatError('too many features');
  const series = [];
  let ignored = 0;
  for (const feature of body.features) {
    const p = isPlain(feature) && isPlain(feature.properties) ? feature.properties : undefined;
    const station = typeof p?.monitoring_location_id === 'string' ? p.monitoring_location_id : '';
    const kind = typeof p?.parameter_code === 'string' ? PARAMETERS[p.parameter_code] : undefined;
    // Another station, another parameter or another statistic (a daily mean): not ours.
    if (
      !p ||
      !asked.has(station) ||
      !Object.hasOwn(PARAMETERS, p.parameter_code) ||
      !(p.statistic_id === INSTANTANEOUS || p.statistic_id === null || p.statistic_id === undefined)
    ) {
      ignored += 1;
      continue;
    }
    const tsid =
      typeof p.time_series_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(p.time_series_id)
        ? p.time_series_id
        : '';
    const unit = SOURCE_UNITS[kind][p.unit_of_measure];
    const raw = parseValue(p.value);
    let value;
    if (raw === null) {
      value = null;
    } else if (raw !== undefined && unit) {
      const converted = canonical(unit, raw);
      const [min, max] = BOUNDS[kind];
      value = converted >= min && converted <= max ? converted : undefined;
    }
    series.push({
      station,
      kind,
      tsid,
      time: parseInstant(p.time),
      value,
      ...(({ codes, blocked }) => ({ qualifiers: codes, blocked }))(qualifiersOf(p.qualifier)),
      provisional: p.approval_status !== 'Approved',
    });
  }
  return { series, total: body.features.length, ignored, next: nextLink(body) };
}

/** The `next` link of a page, as given (checked by the caller against the base); undefined when none. */
function nextLink(body) {
  if (!Array.isArray(body.links)) return undefined;
  const link = body.links.find((l) => isPlain(l) && l.rel === 'next');
  if (!link) return undefined;
  return typeof link.href === 'string' && link.href.length <= 4096 ? link.href : 'invalid';
}

/**
 * Picks the series to show for one station and one kind, at `ref` (epoch ms,
 * the time of the source): among the current ones with a value no qualifier
 * invalidates, the one of smallest series id (the same one from read to read
 * while it stays current); else a current one without value, or whose value a
 * qualifier invalidates (its qualifiers say why); else the latest one (stale).
 * @returns {{ state: 'fresh'|'novalue'|'stale'|'unreadable', series?: object }}
 */
export function selectSeries(list, ref, maxAge, futureSlack) {
  const dated = list.filter((s) => s.time !== undefined && s.time - ref <= futureSlack);
  const current = dated.filter((s) => ref - s.time <= maxAge);
  const fresh = current
    .filter((s) => typeof s.value === 'number' && !s.blocked)
    .sort((a, b) => (a.tsid < b.tsid ? -1 : a.tsid > b.tsid ? 1 : 0));
  if (fresh.length > 0) return { state: 'fresh', series: fresh[0] };
  const latest = (items) => items.reduce((a, b) => (b.time > a.time ? b : a));
  const empty = current.filter((s) => s.value === null || s.blocked);
  if (empty.length > 0) return { state: 'novalue', series: latest(empty) };
  if (current.length > 0) return { state: 'unreadable', series: latest(current) };
  if (dated.length > 0) return { state: 'stale', series: latest(dated) };
  return { state: 'unreadable' };
}

/**
 * USGS time zone abbreviation and daylight saving flag -> an IANA zone (UTC
 * when unknown). The flag of the USGS is wrong for many stations (EST "N" for
 * most of Florida, 2026-10-30): every U.S. zone follows daylight saving time
 * but Arizona (MST "N"), Hawaii, Puerto Rico and the Pacific territories, so
 * the flag is only used to tell Arizona from the rest of the Mountain zone.
 * `ZP-11` (American Samoa) and the other `ZP±hh` are fixed offsets.
 */
const ZONES = new Map([
  ['EST', ['America/New_York', 'America/New_York']],
  ['CST', ['America/Chicago', 'America/Chicago']],
  ['MST', ['America/Denver', 'America/Phoenix']],
  ['PST', ['America/Los_Angeles', 'America/Los_Angeles']],
  ['AKST', ['America/Anchorage', 'America/Anchorage']],
  ['HST', ['Pacific/Honolulu', 'Pacific/Honolulu']],
  ['AST', ['America/Puerto_Rico', 'America/Puerto_Rico']],
  ['CHST', ['Pacific/Guam', 'Pacific/Guam']],
  ['GST', ['Pacific/Guam', 'Pacific/Guam']],
  ['SST', ['Pacific/Pago_Pago', 'Pacific/Pago_Pago']],
  ['ZP-11', ['Pacific/Pago_Pago', 'Pacific/Pago_Pago']],
  ['UTC', ['UTC', 'UTC']],
]);

export function zoneOf(abbreviation, dst) {
  const key = typeof abbreviation === 'string' ? abbreviation.trim().toUpperCase() : '';
  const pair = ZONES.get(key);
  if (pair) return dst === 'N' ? pair[1] : pair[0];
  // Another fixed offset: ZP-10 is UTC-10, i.e. Etc/GMT+10 (the sign is reversed).
  const fixed = /^ZP([+-])(\d{1,2})$/.exec(key);
  if (fixed && Number(fixed[2]) >= 1 && Number(fixed[2]) <= 12) {
    return `Etc/GMT${fixed[1] === '-' ? '+' : '-'}${Number(fixed[2])}`;
  }
  return 'UTC';
}

/**
 * monitoring-locations -> Map id -> { name, siteType, state, zone }.
 * Throws a FormatError when the envelope is not a feature collection.
 */
export function parseLocations(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new FormatError('not JSON');
  }
  if (!isPlain(body) || body.type !== 'FeatureCollection' || !Array.isArray(body.features)) {
    throw new FormatError('not a feature collection');
  }
  const out = new Map();
  for (const feature of body.features.slice(0, 200)) {
    if (!isPlain(feature) || !isPlain(feature.properties)) continue;
    const id = typeof feature.id === 'string' ? feature.id : '';
    if (!STATION_ID.test(id)) continue;
    const p = feature.properties;
    out.set(id, {
      name: cleanText(p.monitoring_location_name, 100),
      siteType: cleanText(p.site_type, 40),
      state: cleanText(p.state_name, 40),
      zone: zoneOf(p.time_zone_abbreviation, p.uses_daylight_savings),
    });
  }
  return { locations: out, next: nextLink(body) };
}
