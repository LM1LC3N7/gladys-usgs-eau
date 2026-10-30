// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted USGS (a fetch that answers
// from builders or the real captures of test/fixtures) and a virtual clock
// (test/helpers/clock.js).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { WaterApp } from '../../src/app.js';
import { createMemoryStore } from '../../src/store.js';
import { wire } from '../../src/wire.js';
import { settle, testClock } from './clock.js';

export const SELECTOR = 'ue';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
/** 2026-10-30 06:06 UTC: half a minute after the real captures. */
export const NOW = Date.UTC(2026, 9, 30, 6, 6);
export const BASE = 'https://usgs.test/ogcapi/v1';
export const F = (id, key) => `ext:${SELECTOR}:station:${id}:${key}`;
export const D = (id) => `ext:${SELECTOR}:station:${id}`;

export const fixture = (name) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

/** The stations of the real captures. */
export const REAL_STATIONS =
  '01646500, 09380000, 12113000, 354144078460101, 405118099514901, 00000000';

// --- Builders ------------------------------------------------------------------------

const UNITS = { '00060': 'ft^3/s', '00065': 'ft', '00010': 'degC', 72019: 'ft' };
let tsSeq = 0;

/** One feature of latest-continuous. */
export function series({
  station = 'USGS-01646500',
  param = '00060',
  at,
  value = '100',
  unit = UNITS[param],
  qualifier = null,
  tsid,
  statistic = '00011',
}) {
  tsSeq += 1;
  return {
    type: 'Feature',
    properties: {
      time_series_id: tsid ?? `ts${param}${station.replace(/\W/g, '')}`,
      monitoring_location_id: station,
      parameter_code: param,
      statistic_id: statistic,
      time: at === undefined ? undefined : new Date(at).toISOString().replace('.000Z', '+00:00'),
      value,
      unit_of_measure: unit,
      qualifier,
    },
    id: `f${tsSeq}`,
    geometry: null,
  };
}

/** A page of latest-continuous. */
export const latestBody = (features, links = []) => ({
  type: 'FeatureCollection',
  features,
  numberReturned: features.length,
  links,
  timeStamp: new Date(NOW).toISOString(),
});

/** A page of monitoring-locations. */
export function locationsBody(list) {
  return {
    type: 'FeatureCollection',
    features: list.map((l) => ({
      type: 'Feature',
      id: l.id,
      properties: {
        monitoring_location_name: l.name ?? `STATION ${l.id}`,
        site_type: l.siteType ?? 'Stream',
        state_name: l.state ?? 'Maryland',
        time_zone_abbreviation: l.tz ?? 'EST',
        uses_daylight_savings: l.dst ?? 'Y',
      },
      geometry: null,
    })),
    numberReturned: list.length,
    links: [],
  };
}

// --- Source ------------------------------------------------------------------------------

export const json = (body, { status = 200, headers = {} } = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Which endpoint a URL asks: 'latest', 'locations' or 'search'. */
export function routeOf(url) {
  const u = new URL(url);
  if (u.pathname.endsWith('/collections/latest-continuous/items')) return 'latest';
  if (u.pathname.endsWith('/collections/monitoring-locations/items')) {
    return u.searchParams.has('filter') ? 'search' : 'locations';
  }
  return 'other';
}

/**
 * The USGS: `world[route](url, init)` -> a Response, an object (200 JSON with
 * a Date header of the clock), a string, 'hang' (never answers), an Error
 * (network) or a promise of one of these. `requests` lists every request.
 */
export function createSource(clock, world = {}) {
  const source = { world, requests: [] };
  source.fetch = async (url, init) => {
    const route = routeOf(String(url));
    source.requests.push({
      route,
      url: String(url),
      at: clock.monotonic(),
      headers: init?.headers,
    });
    let answer = await source.world[route]?.(String(url), init);
    if (answer === 'hang') {
      answer = await new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    }
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    if (answer === undefined) return json({ error: 'not found' }, { status: 404 });
    return json(answer, { headers: { date: new Date(clock.now()).toUTCString() } });
  };
  source.count = (route) => source.requests.filter((r) => r.route === route).length;
  source.times = (route) => source.requests.filter((r) => r.route === route).map((r) => r.at);
  return source;
}

/** The real captures, as the USGS answered at 06:05 UTC. */
export const realWorld = () => ({
  latest: () => fixture('latest-continuous.json'),
  locations: () => fixture('monitoring-locations.json'),
});

/** A world built from a function of the clock: `values(now)` -> features. */
export function liveWorld(clock, values, locations = undefined) {
  return {
    latest: () => latestBody(values(clock.now())),
    locations: (url) => {
      const ids = new URL(url).searchParams.get('id').split(',');
      return locationsBody(locations ?? ids.map((id) => ({ id })));
    },
  };
}

export const quiet = () => {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  return { lines, info: log, warn: log, error: log, debug: log };
};

export async function setup({
  store = createMemoryStore(),
  config = {},
  world,
  start = NOW,
  clock = testClock({ start }),
  devices = [],
  timers,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  const source = createSource(clock, world ?? realWorld());
  const logger = quiet();
  const app = new WaterApp({
    gladys,
    logger,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: timers ?? clock.timers,
    store,
    fetchImpl: source.fetch,
    base: BASE,
  });
  // The handlers as index.js wires them (deviceCreated, configUpdated...). The
  // 'connected' listener is not used here: `begin()` calls app.connected itself.
  wire(gladys, app, logger);
  gladys.removeAllListeners('connected');
  gladys.removeAllListeners('disconnected');
  const wait = async (ms) => {
    await clock.advance(ms);
    await settle(10);
  };
  const begin = async () => {
    await app.connected(() => gladys.getConfig());
    await wait(0);
    await app.idle();
    await settle(10);
  };
  /** Creates a device of the Discovery list as the user does. */
  const create = async (id) => {
    const device = gladys.fake.discoveredDevices.find((d) => d.external_id === D(id));
    if (!device) throw new Error(`${id} not in Discovery`);
    await gladys.fake.deviceCreated(structuredClone(device));
    await settle(10);
    return device;
  };
  const statesOf = (fid) => gladys.fake.states.filter((s) => s.device_feature_external_id === fid);
  const status = () => gladys.fake.connectionStatus;
  return { app, gladys, clock, store, source, logger, wait, begin, create, statesOf, status };
}
