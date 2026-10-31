// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (manifest
// keys, feature keys, the type part of the external ids) is forever: never
// rename one.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** The version of the package (the release bumps it): the User-Agent follows. */
export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
/** Honest User-Agent, in the name of the integration (never a browser's). */
export const USER_AGENT = `gladys-usgs-eau/${VERSION} (+https://github.com/LM1LC3N7/gladys-usgs-eau)`;

// --- The source ------------------------------------------------------------------------

/**
 * The USGS Water Data OGC APIs (public domain, no account): the latest value
 * of every continuous time series (`latest-continuous`) and the description
 * of the monitoring locations (`monitoring-locations`: name, time zone). Only
 * this new API: the legacy waterservices.usgs.gov is being retired.
 */
export const API_BASE = 'https://api.waterdata.usgs.gov/ogcapi/v1';
export const ACCEPT = 'application/geo+json, application/json;q=0.9';

/** The pause keys (one host: a 429 or a 5xx pauses every request to it). */
export const HOST = 'api';

/** One page of values: ~650 bytes per series, 1000 series at most: cut beyond. */
export const VALUES_MAX_BYTES = 2 * 1024 * 1024;
/** The locations of 20 stations: ~6 KB; a search answer: ~4 KB. */
export const META_MAX_BYTES = 512 * 1024;
/** Series asked per page, and pages followed (`next` link) per read, at most. */
export const PAGE_LIMIT = 1000;
export const MAX_PAGES = 3;
/** One request, from the first byte sent to the last byte read, at most. */
export const REQUEST_TIMEOUT = 20_000;

/**
 * The parameters read (USGS parameter codes) -> the kind of value. Discharge,
 * gage height, water temperature and depth to water below land surface (a
 * groundwater well).
 */
export const PARAMETERS = {
  '00060': 'discharge',
  '00065': 'gage-height',
  '00010': 'water-temperature',
  72019: 'groundwater-depth',
  // Discharge in m³/s, the only discharge of a few stations (5 current on 2026-10-30).
  30208: 'discharge',
};
/** The statistic of an instantaneous value (some series give none). */
export const INSTANTANEOUS = '00011';

/** Stations read, at most (one request for all of them). */
export const MAX_STATIONS = 20;

// --- Schedule ------------------------------------------------------------------------
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The interval between two reads (minutes, the form): default, bounds. */
export const INTERVAL_DEFAULT_MIN = 15;
export const INTERVAL_MIN_MIN = 15;
export const INTERVAL_MAX_MIN = 120;

/** A value older than this many hours is not current (the form): default, bounds. */
export const MAX_AGE_DEFAULT_H = 3;
export const MAX_AGE_MIN_H = 1;
export const MAX_AGE_MAX_H = 48;

/** A value dated more than this in the future is unreadable. */
export const FUTURE_SLACK = 15 * MINUTE;
/** A server `Date` further than this from our clock is not used as the reference. */
export const DATE_HEADER_TRUST = DAY;
/** A timer that fires up to this much early is armed again for the rest (never a read sooner, never a round skipped). */
export const EARLY_SLACK = SECOND;
/** The station list changed: the next read comes at once, but never sooner than this after the last. */
export const NEW_STATION_GAP = MINUTE;

/** The names and time zones of the stations: read again after this, or after a failure. */
export const META_TTL = 7 * DAY;
export const META_RETRY = HOUR;

/** 429 / 5xx: paused 5 min, doubled, between 60 s and 6 h (Retry-After honoured). */
export const PAUSE_BASE = 5 * MINUTE;
export const PAUSE_MIN = 60 * SECOND;
export const PAUSE_MAX = 6 * HOUR;

/** `getConfig()` failing at a connection: tried again after 5 s, doubled up to 5 min, without end. */
export const CONFIG_RETRY_MIN = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;

/** States sent to Gladys over a rolling minute, at most (the core accepts 300). */
export const STATE_BUDGET = 250;
export const STATE_WINDOW = MINUTE;

/** Two searches never closer than this; a search waits this long at most. */
export const SEARCH_GAP = 10 * SECOND;
export const SEARCH_WAIT = 45 * SECOND;
/** Stations shown by a search, at most. */
export const SEARCH_SHOWN = 15;

/** A save or a load of /data is awaited this long at most (a slow /data never holds the app back). */
export const SAVE_WAIT = 5 * SECOND;
/** A clean stop waits this long, at most, for the read running (then the save, SAVE_WAIT at most). */
export const STOP_WAIT = 3 * SECOND;
/**
 * After a stop signal, the process exits this long after it at the latest:
 * after the clean stop (STOP_WAIT + SAVE_WAIT, 8 s at most, then the SDK
 * closes its connection) and before Docker's SIGKILL, 10 s after its SIGTERM
 * (Gladys stops a container with Docker's default delay).
 */
export const SHUTDOWN_LIMIT = 9 * SECOND;
/** Dates of the last values published kept in /data, at most. */
export const MAX_PUBLISHED = 400;
/** A status text, at most (characters). */
export const MAX_STATUS_LENGTH = 120;
