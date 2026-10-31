// -----------------------------------------------------------------------------
// The integration itself: the latest values of the USGS stations of the form,
// read at the pace of the form (one request for all the stations), one Gladys
// device per station, each value published once per measurement while it is
// current, a status text per station, the pace, the pause and what was
// published kept in /data. index.js only wires the SDK handlers to it.
// Read-only: nothing is ever sent to the USGS but GET requests.
//
// One read = the latest values (latest-continuous, up to MAX_PAGES pages),
// then, when due, the names and time zones of the stations
// (monitoring-locations, once a week; never blocking: a failure leaves the
// ids as names and the times in UTC). One request at a time to the host, the
// search button included.
//
// The pace is kept across restarts: never two reads less than an interval
// apart, whatever asks (a reconnection, a save of the form, the Discovery tab,
// a device created, a restart: the time of the read is written to /data
// before the request). A /data that cannot be read, or a date in it that is
// invalid or in the future, puts the first read one interval after the start.
// A new station list is read at once, but never less than a minute after the
// last read. The next read is armed before anything is awaited: a slow /data
// or a slow source never holds it back. A 429 or a 5xx pauses the host
// (persisted); the read is then armed at the end of the pause, never a round
// later.
//
// Freshness: a value is published once per measurement (deduplicated on the
// time of the measurement, kept in /data), only while it is at most the
// maximum age of the form old (against the `Date` of the answer), without
// `created_at`. A value the source does not give (dry, ice, equipment), an
// unreadable or stale one is never published as a number: the status text of
// the station says it, and the connection status says when no station has a
// current value or when the read failed.
//
// Two clocks: `now` (wall clock) only for /data and the reference of an
// answer without a usable `Date` header; `monotonic` for the pace, the pause,
// the budget and the ages, so that a wall clock set back or forward never
// stops nor hurries them.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  ACCEPT,
  API_BASE,
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  DATE_HEADER_TRUST,
  EARLY_SLACK,
  FUTURE_SLACK,
  HOUR,
  MAX_PAGES,
  MAX_PUBLISHED,
  MAX_STATIONS,
  META_MAX_BYTES,
  META_RETRY,
  META_TTL,
  MINUTE,
  NEW_STATION_GAP,
  PAUSE_BASE,
  PAUSE_MAX,
  PAUSE_MIN,
  SAVE_WAIT,
  SEARCH_GAP,
  SEARCH_SHOWN,
  SEARCH_WAIT,
  STATE_BUDGET,
  STATE_WINDOW,
  STOP_WAIT,
  VALUES_MAX_BYTES,
} from './constants.js';
import { FEATURES, KINDS, buildDevice, idsOf, parseDeviceId, validId } from './devices.js';
import { FetchError, getText } from './http.js';
import { T, deviceStatus, joinMessages } from './i18n.js';
import { createFileStore } from './store.js';
import {
  FormatError,
  cleanText,
  latestUrl,
  locationsUrl,
  parseLatest,
  parseLocations,
  searchUrl,
  searchWords,
  selectSeries,
} from './usgs.js';

const defaultTimers = { setTimeout, clearTimeout };
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const PAUSE_CODES = new Set(['rate_limited', 'server']);
const ZONE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/;

/** The list started at `cursor` (modulo its length), wrapping around. */
function rotate(list, cursor) {
  if (list.length === 0) return list;
  const start = cursor % list.length;
  return [...list.slice(start), ...list.slice(0, start)];
}

/** A promise raced against a timer: `fallback` when the timer wins. */
async function bounded(timers, promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = timers.setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    timers.clearTimeout(timer);
  }
}

/** The pause read back from /data: in memory it ends at a monotonic `due`, its rest capped to PAUSE_MAX. */
function validPause(pause, now, mono) {
  if (
    !pause ||
    !finite(pause.until) ||
    !Number.isInteger(pause.count) ||
    pause.count < 1 ||
    !PAUSE_CODES.has(pause.code)
  ) {
    return undefined;
  }
  // An ended pause is kept for its count (the next one is doubled), until a success.
  const left = Math.min(Math.max(0, pause.until - now), PAUSE_MAX);
  return {
    until: now + left,
    due: mono + left,
    count: Math.min(pause.count, 32),
    code: pause.code,
    status: Number.isInteger(pause.status) ? pause.status : undefined,
  };
}

/** The stations kept in /data, checked one by one. */
function keptStations(list, now) {
  const stations = new Map();
  if (!Array.isArray(list)) return stations;
  for (const entry of list.slice(0, 100)) {
    if (!entry || !validId(entry.id)) continue;
    stations.set(entry.id, {
      id: entry.id,
      name: cleanText(entry.name, 100) || undefined,
      siteType: cleanText(entry.siteType, 40) || undefined,
      state: cleanText(entry.state, 40) || undefined,
      zone: typeof entry.zone === 'string' && ZONE.test(entry.zone) ? entry.zone : undefined,
      kinds: new Set(
        Array.isArray(entry.kinds) ? entry.kinds.filter((k) => KINDS.includes(k)) : [],
      ),
      unknown: entry.unknown === true,
      metaAt: finite(entry.metaAt) && entry.metaAt <= now ? entry.metaAt : undefined,
      readAt: finite(entry.readAt) && entry.readAt <= now ? entry.readAt : undefined,
    });
  }
  return stations;
}

/** The measurement times of the values published, by feature external id. */
function keptPublished(object) {
  const published = new Map();
  if (!object || typeof object !== 'object' || Array.isArray(object)) return published;
  for (const [key, value] of Object.entries(object)) {
    if (key.length <= 200 && key !== '__proto__' && finite(value)) published.set(key, value);
  }
  return new Map([...published].slice(-MAX_PUBLISHED));
}

const stationsKey = (ids) => ids.join(',');
/** A date of /data before this (a zero, a negative number) is invalid, never "long ago". */
const OLDEST = Date.UTC(2020, 0, 1);

export class WaterApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'usgs-eau' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    store = createFileStore(),
    fetchImpl = (...args) => fetch(...args),
    base = API_BASE,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.base = base;
    this.config = normalizeConfig();
    this.running = false;
    this.run = 0;
    this.timer = undefined;
    this.busy = undefined;
    this.abort = undefined;
    this.lifecycle = Promise.resolve();
    this.connection = 0;
    this.configTimer = undefined;
    this.configFailures = 0;
    this.configRun = undefined;
    this.lastStatus = undefined;
    /** Status texts sent, by feature (forgotten at each start: Gladys may have lost them). */
    this.sentTexts = new Map();
    /** States sent to Gladys over the last minute: [{ at (monotonic), n }]. */
    this.sentLog = [];
    this.deferred = false;
    this.saveFailed = false;
    this.saveLate = false;
    /** The outcome of the last attempt: undefined | { ok: true } | { ok: false, code, status? }. */
    this.outcome = { values: undefined, meta: undefined };
    /** The last values read, in memory only: { byStation: Map, ref (wall), at (monotonic), key }. */
    this.values = undefined;
    /** One request at a time to the host (reads and searches). */
    this.hostQueue = Promise.resolve();
    this.lastSearchMono = undefined;
    /** A read whose values have not come yet; a read cut by a stop is read again a minute later. */
    this.readingGen = undefined;
    this.cut = false;
    /** A wake-up found a read or a refresh running: armed again when it ends. */
    this.wanted = false;

    /** /data is read (bounded) at the first start: nothing is written before. */
    this.loaded = false;
    this.loading = undefined;
    this.dataUnreadable = false;
    this.dataBlocked = false;
    this.baseline = false;
    this.pause = undefined;
    this.stations = new Map();
    this.published = new Map();
    this.lastAttemptAt = undefined;
    this.lastReadMono = undefined;
    /** The station list of the last read (a new list is read sooner). */
    this.readKey = undefined;
    this.lastOk = undefined;
    this.metaTriedMono = undefined;
    /** Fair rotation of the states put off by the budget. */
    this.cursor = { values: 0, texts: 0 };
    this.publishRun = Promise.resolve();
    this.discoveryKey = undefined;
  }

  /** Reads /data once, bounded in time (a /data that never answers is unreadable, not empty). */
  load() {
    if (!this.loading) this.loading = this.doLoad();
    return this.loading;
  }

  async doLoad() {
    let loaded;
    try {
      loaded = await bounded(
        this.timers,
        Promise.resolve().then(() => this.store.load()),
        SAVE_WAIT,
        { ok: false, code: 'timeout' },
      );
    } catch {
      loaded = { ok: false, code: 'error' };
    }
    const at = this.now();
    const mono = this.monotonic();
    const kept = loaded?.ok && loaded.data && typeof loaded.data === 'object' ? loaded.data : {};
    /** /data unreadable: set aside at the first start; values seen first are a baseline, not news. */
    this.dataUnreadable = !loaded?.ok;
    this.dataBlocked = !loaded?.ok;
    this.baseline = this.dataUnreadable;
    this.pause = validPause(kept.pause, at, mono);
    this.stations = keptStations(kept.stations, at);
    this.published = keptPublished(kept.published);
    this.readKey = typeof kept.readKey === 'string' ? kept.readKey.slice(0, 600) : undefined;
    this.lastOk = finite(kept.lastOk) && kept.lastOk <= at ? kept.lastOk : undefined;
    // The last read before a restart: the next one never comes sooner than the
    // interval. No file yet (first start): at once. A file that cannot be
    // read, or a date that is invalid or in the future: as if read just now.
    if (loaded?.ok && loaded.absent) {
      this.lastAttemptAt = undefined;
      this.lastReadMono = undefined;
    } else if (
      !loaded?.ok ||
      (kept.lastAttemptAt !== undefined &&
        !(finite(kept.lastAttemptAt) && kept.lastAttemptAt > OLDEST))
    ) {
      this.lastAttemptAt = at;
      this.lastReadMono = mono;
    } else if (finite(kept.lastAttemptAt)) {
      const when = Math.min(kept.lastAttemptAt, at);
      this.lastAttemptAt = when;
      this.lastReadMono = mono - (at - when);
    }
    this.loaded = true;
  }

  get intervalMs() {
    return this.config.intervalMinutes * MINUTE;
  }

  get maxAgeMs() {
    return this.config.maxAgeHours * HOUR;
  }

  // --- Connection to Gladys -------------------------------------------------------

  /**
   * A (re)connection to Gladys: its configuration, then a start. A
   * `getConfig()` that fails is tried again without end (5 s doubled up to
   * 5 min), the status saying so, until it answers or the connection ends.
   */
  connected(getConfig) {
    const token = ++this.connection;
    this.configFailures = 0;
    this.clearConfigTimer();
    this.configRun = this.tryConfig(getConfig, token);
    return this.configRun;
  }

  /** The connection to Gladys is lost: the retries of getConfig end, the reads stop. */
  disconnected() {
    this.connection += 1;
    this.clearConfigTimer();
    return this.serialize(async () => {
      this.doStop();
      await this.saveState();
    });
  }

  /** The user saved the form: this configuration wins over a getConfig still being tried. */
  configUpdated(raw) {
    this.connection += 1;
    this.clearConfigTimer();
    return this.start(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  async tryConfig(getConfig, token) {
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (token !== this.connection) return;
      const wait = Math.min(CONFIG_RETRY_MIN * 2 ** this.configFailures, CONFIG_RETRY_MAX);
      this.configFailures = Math.min(this.configFailures + 1, 16);
      this.logger.warn(`The configuration could not be read (${err?.name ?? 'Error'})`);
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(wait));
      if (token !== this.connection) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.configRun = this.tryConfig(getConfig, token);
        return this.configRun;
      }, wait);
      return;
    }
    if (token !== this.connection) return;
    this.configFailures = 0;
    await this.start(raw);
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Queued: configurations saved one after the other apply one by one, the last one wins. */
  start(raw = {}) {
    return this.serialize(() => this.doStart(raw));
  }

  /** Stops the reads, waits (bounded) for the one running, and writes /data. */
  stop() {
    this.connection += 1;
    this.clearConfigTimer();
    return this.serialize(async () => {
      this.doStop();
      if (this.busy)
        await bounded(
          this.timers,
          this.busy.catch(() => {}),
          STOP_WAIT,
        );
      await this.saveState();
    });
  }

  /** Resolves once every queued start/stop and the read running are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.configRun;
    await this.busy;
    await this.publishRun;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async doStart(raw) {
    this.doStop();
    this.config = normalizeConfig(raw);
    const gen = this.run;
    await this.load();
    if (gen !== this.run) return;
    if (this.dataUnreadable && this.dataBlocked) {
      // Never overwritten: kept under another name, then a fresh file.
      // Bounded like a save: a /data that never answers never holds the start
      // back (nor the stop queued behind it); it is then never written.
      const aside = await bounded(
        this.timers,
        Promise.resolve()
          .then(() => this.store.setAside(this.now()))
          .then(
            () => true,
            () => false,
          ),
        SAVE_WAIT,
        false,
      );
      if (aside) {
        this.dataBlocked = false;
        this.logger.warn('/data could not be read: the file was set aside');
      } else {
        this.logger.error('/data could not be read nor set aside: nothing is written to it');
      }
      if (gen !== this.run) return;
    }
    if (this.values && this.values.key !== stationsKey(this.config.stations)) {
      // Another station list: the values of the last read no longer answer it.
      this.values = undefined;
      this.outcome = { values: undefined, meta: undefined };
    }
    this.running = true;
    // The core keeps the connection status and the Discovery list in memory:
    // a restarted Gladys has lost them, so they are always sent again; the
    // status texts too (the values only for a newer measurement).
    this.lastStatus = undefined;
    this.sentTexts.clear();
    this.discoveryKey = undefined;
    // The next read is armed before anything is awaited.
    this.schedule();
    await this.publishDiscovery();
    if (gen !== this.run) return;
    // Queued behind a publication in flight, never awaited here: a slow Gladys
    // never holds a start back, and nothing is sent twice (see publishValues).
    this.publishValues().catch(() => {});
    await this.updateStatus();
  }

  doStop() {
    if (this.readingGen !== undefined && this.readingGen === this.run) {
      // A read cut before its values came (a save of the form, a
      // reconnection): read again a minute after it, not a round later.
      this.cut = true;
    }
    this.running = false;
    this.run += 1;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.abort?.abort();
    this.abort = undefined;
  }

  // --- Schedule ----------------------------------------------------------------

  /** When the next read is due (monotonic): the interval after the last one, a new list sooner, never in a pause. */
  nextDue(mono) {
    let next = this.lastReadMono === undefined ? mono : this.lastReadMono + this.intervalMs;
    // A list never read before (readKey unknown: first start, /data unreadable) is not "new".
    if (
      this.lastReadMono !== undefined &&
      this.readKey !== undefined &&
      this.readKey !== stationsKey(this.config.stations)
    ) {
      next = Math.min(next, this.lastReadMono + NEW_STATION_GAP);
    }
    if (this.cut && this.lastReadMono !== undefined) {
      next = Math.min(next, this.lastReadMono + NEW_STATION_GAP);
    }
    if (this.pause && this.pause.due > next) next = this.pause.due;
    return next;
  }

  /**
   * Arms the next wake-up: at the next read, or after an interval when the
   * read is further away (a long pause: the status texts are refreshed meanwhile).
   */
  schedule(minDelay = 0) {
    if (!this.running) return;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.config.stations.length === 0) return;
    const mono = this.monotonic();
    const due = Math.min(this.nextDue(mono), mono + this.intervalMs);
    const delay = Math.max(0, due - mono, minDelay);
    const gen = this.run;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (gen !== this.run || !this.running) return undefined;
      return this.tick(gen);
    }, delay);
  }

  /** A wake-up: one read at a time, the next one armed first; a timer a little early never skips a round nor reads sooner. */
  tick(gen) {
    if (this.busy) {
      // A read or a refresh still running (a slow /data, a slow Gladys):
      // looked at again as soon as it ends, in a minute at the latest.
      this.wanted = true;
      this.schedule(MINUTE);
      return undefined;
    }
    const mono = this.monotonic();
    const due = this.nextDue(mono);
    if (mono < due) {
      if (due - mono <= EARLY_SLACK) {
        // A timer a little early (a real timer against performance.now()):
        // armed again for the rest, never read sooner, never a round skipped.
        this.schedule(due - mono + 1);
        return undefined;
      }
      // Not due (a pause still running): the status texts age, the read stays armed.
      this.schedule();
      return this.track(this.refresh(gen));
    }
    this.lastReadMono = mono;
    this.lastAttemptAt = this.now();
    this.readKey = stationsKey(this.config.stations);
    this.cut = false;
    this.schedule();
    return this.track(this.read(gen));
  }

  /** The work of a wake-up: one at a time; a wake-up that found it running is armed again when it ends. */
  track(work) {
    const tracked = work.finally(() => {
      this.busy = undefined;
      if (this.wanted) {
        this.wanted = false;
        this.schedule();
      }
    });
    this.busy = tracked;
    return tracked;
  }

  /** No request: the status texts and the connection status follow the ages. */
  async refresh(gen) {
    try {
      await this.publishValues();
      if (gen !== this.run) return;
      await this.updateStatus();
    } catch (err) {
      this.logger.error(`Refresh failed (${err?.name ?? 'Error'})`);
    }
  }

  // --- Requests ----------------------------------------------------------------------

  /**
   * One GET to the host, after the requests before it (one at a time). A job
   * still waiting after `wait` ms is dropped (FetchError 'busy').
   */
  request(options, { signal, wait } = {}) {
    let started = false;
    let dropped = false;
    const job = this.hostQueue.then(() => {
      if (dropped) throw new FetchError('busy');
      started = true;
      return getText({
        accept: ACCEPT,
        signal,
        fetchImpl: this.fetchImpl,
        timers: this.timers,
        ...options,
      });
    });
    this.hostQueue = job.catch(() => {});
    if (wait === undefined) return job;
    return bounded(
      this.timers,
      job.then(
        (answer) => ({ answer }),
        (error) => ({ error }),
      ),
      wait,
      undefined,
    ).then((result) => {
      if (result === undefined) {
        if (!started) dropped = true;
        throw new FetchError(started ? 'timeout' : 'busy');
      }
      if (result.error) throw result.error;
      return result.answer;
    });
  }

  /** The reference "now" of an answer: its Date header, when close to our clock. */
  refOf(answer) {
    const wall = this.now();
    return finite(answer.date) && Math.abs(answer.date - wall) <= DATE_HEADER_TRUST
      ? answer.date
      : wall;
  }

  // --- One read ------------------------------------------------------------------

  async read(gen) {
    const abort = new AbortController();
    this.abort = abort;
    const ids = this.config.stations;
    try {
      // The time of this attempt in /data before any request (the pace survives a restart).
      this.readingGen = gen;
      await this.saveState();
      if (gen !== this.run) return;
      await this.readValues(gen, ids, abort.signal);
      if (gen !== this.run) return;
      this.readingGen = undefined;
      if (this.outcome.values?.ok) await this.readMeta(gen, ids, abort.signal);
      if (gen !== this.run) return;
      await this.publishDiscovery();
      if (gen !== this.run) return;
      await this.publishValues();
      if (gen !== this.run) return;
      await this.updateStatus();
      await this.saveState();
    } catch (err) {
      this.logger.error(`Read failed (${err?.name ?? 'Error'})`);
    } finally {
      if (this.abort === abort) this.abort = undefined;
      if (this.readingGen === gen) this.readingGen = undefined;
    }
  }

  async readValues(gen, ids, signal) {
    const asked = new Set(ids);
    const prefix = `${this.base}/collections/latest-continuous/items?`;
    const series = [];
    let total = 0;
    let ref;
    let url = latestUrl(this.base, ids);
    try {
      for (let page = 1; ; page += 1) {
        const answer = await this.request({ url, maxBytes: VALUES_MAX_BYTES }, { signal });
        if (gen !== this.run) return;
        ref ??= this.refOf(answer);
        const parsed = parseLatest(answer.text, asked);
        series.push(...parsed.series);
        total += parsed.total;
        if (parsed.next === undefined) break;
        // Another page: only on the same endpoint, and a few at most.
        if (page >= MAX_PAGES || !parsed.next.startsWith(prefix)) {
          throw new FetchError('incomplete');
        }
        url = parsed.next;
      }
      // A format that changed (renamed fields): every series refused is not "no data".
      const usable = series.filter((s) => s.time !== undefined && s.value !== undefined).length;
      if (total > 0 && usable === 0) {
        throw new FormatError('nothing readable');
      }
    } catch (err) {
      if (gen !== this.run) return;
      if (err instanceof FormatError) {
        this.outcome.values = { ok: false, code: 'format' };
        this.logger.warn(`Values: unexpected format (${err.message})`);
        return;
      }
      if (!(err instanceof FetchError)) throw err;
      this.outcome.values = this.failed('values', err);
      return;
    }
    const at = this.monotonic();
    const wall = this.now();
    const byStation = new Map(ids.map((id) => [id, new Map()]));
    for (const s of series) {
      const kinds = byStation.get(s.station);
      if (!kinds.has(s.kind)) kinds.set(s.kind, []);
      kinds.get(s.kind).push(s);
    }
    this.values = { byStation, ref, at, key: stationsKey(ids) };
    this.outcome.values = { ok: true };
    this.pause = undefined;
    this.lastOk = wall;
    // The stations read join the catalog; the kinds current now join their device.
    for (const id of ids) {
      const entry = this.entryOf(id);
      entry.readAt = wall;
      for (const [kind, list] of byStation.get(id)) {
        if (selectSeries(list, ref, this.maxAgeMs, FUTURE_SLACK).state === 'fresh') {
          entry.kinds.add(kind);
        }
      }
    }
    this.trimStations();
  }

  /** The names and time zones of the stations: once a week, after a failure an hour later; never blocking. */
  async readMeta(gen, ids, signal) {
    const wall = this.now();
    const mono = this.monotonic();
    const due = ids.filter((id) => {
      const entry = this.stations.get(id);
      return !entry?.metaAt || wall - entry.metaAt > META_TTL;
    });
    if (due.length === 0) return;
    if (this.metaTriedMono !== undefined && mono - this.metaTriedMono < META_RETRY) return;
    this.metaTriedMono = mono;
    let locations;
    try {
      const answer = await this.request(
        { url: locationsUrl(this.base, ids), maxBytes: META_MAX_BYTES },
        { signal },
      );
      if (gen !== this.run) return;
      ({ locations } = parseLocations(answer.text));
    } catch (err) {
      if (gen !== this.run) return;
      if (err instanceof FormatError) {
        this.outcome.meta = { ok: false, code: 'format' };
        return;
      }
      if (!(err instanceof FetchError)) throw err;
      this.outcome.meta = this.failed('meta', err);
      return;
    }
    const at = this.now();
    for (const id of ids) {
      const entry = this.entryOf(id);
      const found = locations.get(id);
      entry.metaAt = at;
      entry.unknown = !found;
      if (found) {
        entry.name = found.name || undefined;
        entry.siteType = found.siteType || undefined;
        entry.state = found.state || undefined;
        entry.zone = found.zone;
      }
    }
    this.outcome.meta = { ok: true };
  }

  /**
   * A request that failed -> its outcome. A 429 pauses every request to the
   * host (its rate limit is per host); a 5xx of the values pauses the reads; a
   * 5xx of the names or of a search never pauses the values (a secondary
   * endpoint never blocks). Bounded, kept in /data; the pause ends with the
   * next answer of the values. The wake-up armed sees the pause and moves the
   * read to its end (see tick).
   */
  failed(what, err) {
    const code = err.code;
    if (code === 'rate_limited' || (code === 'server' && what === 'values')) {
      const count = (this.pause?.count ?? 0) + 1;
      const doubled = PAUSE_BASE * 2 ** Math.min(count - 1, 10);
      const wait = Math.min(Math.max(doubled, err.retryAfter ?? 0, PAUSE_MIN), PAUSE_MAX);
      this.pause = {
        until: this.now() + wait,
        due: this.monotonic() + wait,
        count,
        code,
        status: err.status,
      };
    }
    this.logger.warn(`${what}: request failed (${code}${err.status ? ` ${err.status}` : ''})`);
    return { ok: false, code, status: err.status };
  }

  entryOf(id) {
    let entry = this.stations.get(id);
    if (!entry) {
      entry = { id, kinds: new Set(), unknown: false };
      this.stations.set(id, entry);
    }
    return entry;
  }

  /** The stations no longer in the form leave the catalog (bounded). */
  trimStations() {
    const keep = new Set(this.config.stations);
    for (const id of this.stations.keys()) {
      if (!keep.has(id)) this.stations.delete(id);
    }
  }

  // --- What a station shows ------------------------------------------------------

  /**
   * The values and the status of one station now.
   * @returns {{ code: string, zone: string, time?: number,
   *   behind?: Array<{ kind: string, qualifiers: string[] }>, flags?: string[],
   *   provisional?: boolean, qualifiers?: string[],
   *   values: Record<string, { value: number, stamp: number }> }}
   * `flags`: the codes that nuance a value published (estimated...), `provisional`:
   * a value published is not approved yet; `behind`: the kinds of the device
   * not current now, with the codes that invalidate them when there are some.
   */
  viewOf(id, mono) {
    const entry = this.stations.get(id);
    const zone = entry?.zone ?? 'UTC';
    const values = {};
    if (!this.values) return { code: 'waiting', zone, values };
    const kinds = this.values.byStation.get(id);
    if (!kinds || kinds.size === 0) {
      return { code: entry?.unknown ? 'unknown' : 'none', zone, values };
    }
    const ref = this.values.ref + (mono - this.values.at);
    const picks = new Map();
    for (const [kind, list] of kinds) {
      picks.set(kind, selectSeries(list, ref, this.maxAgeMs, FUTURE_SLACK));
    }
    let latest;
    const flags = [];
    let provisional = false;
    for (const kind of KINDS) {
      const pick = picks.get(kind);
      if (pick?.state !== 'fresh') continue;
      values[kind] = { value: pick.series.value, stamp: pick.series.time };
      if (latest === undefined || pick.series.time > latest) latest = pick.series.time;
      for (const code of pick.series.qualifiers) if (!flags.includes(code)) flags.push(code);
      if (pick.series.provisional) provisional = true;
    }
    if (latest !== undefined) {
      const behind = KINDS.filter(
        (kind) => entry?.kinds.has(kind) && picks.get(kind)?.state !== 'fresh',
      ).map((kind) => ({
        kind,
        qualifiers: picks.get(kind)?.state === 'novalue' ? picks.get(kind).series.qualifiers : [],
      }));
      return { code: 'ok', zone, time: latest, behind, flags, provisional, values };
    }
    const first = (state) => KINDS.map((k) => picks.get(k)).find((p) => p?.state === state);
    const empty = first('novalue');
    if (empty) {
      return {
        code: 'novalue',
        zone,
        time: empty.series.time,
        qualifiers: empty.series.qualifiers,
        values,
      };
    }
    if (first('unreadable')) return { code: 'unreadable', zone, values };
    let last;
    for (const pick of picks.values()) {
      if (pick.state === 'stale' && (last === undefined || pick.series.time > last)) {
        last = pick.series.time;
      }
    }
    return { code: 'stale', zone, time: last, values };
  }

  // --- Discovery -------------------------------------------------------------------

  /** The Discovery list from the stations read; never a read. */
  async scan() {
    this.discoveryKey = undefined;
    await this.publishDiscovery();
  }

  async publishDiscovery() {
    const devices = [];
    for (const id of this.config.stations) {
      const entry = this.stations.get(id);
      // Listed once read: its features are known (a device never loses one).
      if (!entry?.readAt) continue;
      devices.push(
        buildDevice(
          this.gladys,
          { id, name: entry.name, kinds: entry.kinds },
          { units: this.config.units, language: this.config.language },
        ),
      );
    }
    const key = JSON.stringify(devices);
    if (key === this.discoveryKey) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discoveryKey = key;
    } catch (err) {
      this.logger.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  // --- Publication -------------------------------------------------------------------

  /** States still allowed this minute (the core accepts 300 per minute). */
  budgetLeft(mono) {
    this.sentLog = this.sentLog.filter((entry) => mono - entry.at < STATE_WINDOW);
    return STATE_BUDGET - this.sentLog.reduce((sum, entry) => sum + entry.n, 0);
  }

  /** The devices of this integration the user created: [{ id, features: Set }]. */
  createdDevices() {
    const list = [];
    for (const device of this.gladys.devices ?? []) {
      const id = parseDeviceId(this.gladys, device?.external_id);
      if (!id) continue;
      const features = new Set((device.features ?? []).map((f) => f?.external_id));
      list.push({ id, features });
    }
    return list;
  }

  /**
   * The values not published yet (each measurement once), then the status
   * texts that changed, within the budget. One publication at a time
   * (queued): a start or a device created during a publication waits for it,
   * and sees what it sent.
   */
  publishValues() {
    const run = this.publishRun.then(() => this.doPublish());
    this.publishRun = run.catch(() => {});
    return run;
  }

  async doPublish() {
    if (!this.running) return;
    const mono = this.monotonic();
    const values = [];
    const texts = [];
    const configured = new Set(this.config.stations);
    for (const device of this.createdDevices()) {
      // A station no longer in the form is no longer read: nothing to say about it.
      if (!configured.has(device.id)) continue;
      const view = this.viewOf(device.id, mono);
      const ids = idsOf(this.gladys, device.id);
      for (const [key, def] of FEATURES) {
        const fid = ids.feature(key);
        const value = view.values[def.kind];
        if (!value || !device.features.has(fid)) continue;
        const last = this.published.get(fid);
        if (last !== undefined && value.stamp <= last) continue;
        if (this.baseline) {
          // /data was unreadable: what is there now may have been published before.
          this.published.set(fid, value.stamp);
          continue;
        }
        values.push({ fid, state: def.convert(value.value), stamp: value.stamp });
      }
      const fid = ids.feature('status');
      // Nothing read yet since the start: Gladys keeps the last status shown.
      if (device.features.has(fid) && view.code !== 'waiting') {
        const text = deviceStatus(this.config.language, view);
        if (this.sentTexts.get(fid) !== text) texts.push({ fid, text });
      }
    }
    if (this.baseline && this.values) this.baseline = false;
    let left = Math.max(0, this.budgetLeft(mono));
    this.deferred = values.length + texts.length > left;
    // Under the budget, the states put off start the next round (fair rotation).
    const sendValues = rotate(values, this.cursor.values).slice(0, left);
    if (values.length > sendValues.length) this.cursor.values += sendValues.length;
    left -= sendValues.length;
    const sendTexts = rotate(texts, this.cursor.texts).slice(0, left);
    if (texts.length > sendTexts.length) this.cursor.texts += sendTexts.length;
    for (let i = 0; i < sendValues.length; i += 100) {
      const batch = sendValues.slice(i, i + 100);
      // Counted and marked BEFORE the request: a start or a reconnection
      // during it never sends the same measurement again nor passes the budget.
      this.sentLog.push({ at: mono, n: batch.length });
      const before = batch.map((v) => this.published.get(v.fid));
      for (const v of batch) this.published.set(v.fid, v.stamp);
      try {
        await this.gladys.publishStates(
          batch.map((v) => ({ device_feature_external_id: v.fid, state: v.state })),
        );
      } catch (err) {
        // Refused: sent again at the next publication (unless a newer one took its place).
        batch.forEach((v, k) => {
          if (this.published.get(v.fid) !== v.stamp) return;
          if (before[k] === undefined) this.published.delete(v.fid);
          else this.published.set(v.fid, before[k]);
        });
        this.logger.warn(`Values not published (${err?.name ?? 'Error'}): next read`);
        this.deferred = true;
        return;
      }
    }
    if (this.published.size > MAX_PUBLISHED) {
      this.published = new Map([...this.published].slice(-MAX_PUBLISHED));
    }
    for (let i = 0; i < sendTexts.length; i += 100) {
      const batch = sendTexts.slice(i, i + 100);
      this.sentLog.push({ at: mono, n: batch.length });
      for (const t of batch) this.sentTexts.set(t.fid, t.text);
      try {
        await this.gladys.publishStates(
          batch.map((t) => ({ device_feature_external_id: t.fid, text: t.text })),
        );
      } catch (err) {
        for (const t of batch) {
          if (this.sentTexts.get(t.fid) === t.text) this.sentTexts.delete(t.fid);
        }
        this.logger.warn(`Statuses not published (${err?.name ?? 'Error'})`);
        this.deferred = true;
        return;
      }
    }
  }

  /** A device created: Gladys holds nothing for it, its current values in memory are sent at once (never a read). */
  async onDeviceCreated(device) {
    this.forgetDevice(device);
    if (this.running) await this.publishValues();
  }

  /** A device renamed or moved: Gladys keeps its values, nothing to send again. */
  async onDeviceUpdated() {}

  async onDeviceDeleted(device) {
    this.forgetDevice(device);
  }

  /** Gladys holds nothing for this device: its current values may be sent again. */
  forgetDevice(device) {
    const id = parseDeviceId(this.gladys, device?.external_id);
    if (!id) return;
    const ids = idsOf(this.gladys, id);
    for (const key of [...FEATURES.keys(), 'status']) {
      this.published.delete(ids.feature(key));
      this.sentTexts.delete(ids.feature(key));
    }
  }

  // --- Status ------------------------------------------------------------------------

  async updateStatus() {
    const mono = this.monotonic();
    const parts = [];
    const ids = this.config.stations;
    for (const note of this.config.notes) parts.push(T.notes[note]);
    if (this.dataUnreadable) parts.push(T.dataUnreadable);
    if (this.saveFailed || this.saveLate || this.dataBlocked) parts.push(T.dataUnwritable);
    if (ids.length === 0) {
      await this.setStatus(false, joinMessages([T.noStation, ...parts]));
      return;
    }
    const outcome = this.outcome.values;
    let connected = false;
    if (!outcome && this.pause && this.pause.due > mono) {
      // A pause read back from /data: said as such, not as a wait.
      parts.unshift(
        T.paused({ code: this.pause.code, status: this.pause.status }, this.pause.until),
      );
    } else if (!outcome) {
      const left = Math.max(0, this.nextDue(mono) - mono);
      parts.unshift(T.waiting(left));
    } else if (outcome.ok) {
      let fresh = 0;
      let unknown = 0;
      let flagged = 0;
      for (const id of ids) {
        const view = this.viewOf(id, mono);
        if (view.code === 'ok') fresh += 1;
        if (view.code === 'ok' && view.flags.length > 0) flagged += 1;
        if (view.code === 'unknown') unknown += 1;
      }
      connected = fresh > 0;
      parts.unshift(fresh > 0 ? T.ok(ids.length, fresh) : T.noneCurrent(ids.length));
      if (flagged > 0) parts.push(T.flagged(flagged));
      if (unknown > 0) parts.push(T.unknown(unknown));
      // A 429 of a search after the read: the next read waits for its end.
      if (this.pause && this.pause.due > mono) {
        parts.push(
          T.paused({ code: this.pause.code, status: this.pause.status }, this.pause.until),
        );
      }
    } else if (this.pause && this.pause.due > mono) {
      parts.unshift(T.paused(outcome, this.pause.until));
    } else {
      parts.unshift(T.failed(outcome));
    }
    if (this.outcome.meta && !this.outcome.meta.ok) parts.push(T.meta(this.outcome.meta));
    if (this.deferred) parts.push(T.budget);
    await this.setStatus(connected, joinMessages(parts));
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    try {
      await this.gladys.setConnectionStatus(connected, message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Status not sent (${err?.name ?? 'Error'})`);
    }
  }

  // --- Search (Configuration button) ------------------------------------------------

  /**
   * Stations whose name holds every word typed. One request, after the read
   * running if any, never during a pause, never two within SEARCH_GAP.
   */
  async search(fields) {
    const words = searchWords(fields?.query);
    if (words.length === 0) return T.searchEmpty;
    await this.load();
    const mono = this.monotonic();
    if (this.pause && this.pause.due > mono) {
      return T.searchPaused(this.pause.until);
    }
    if (this.lastSearchMono !== undefined && mono - this.lastSearchMono < SEARCH_GAP) {
      return T.searchWait(SEARCH_GAP - (mono - this.lastSearchMono));
    }
    this.lastSearchMono = mono;
    let locations;
    let more;
    try {
      const answer = await this.request(
        { url: searchUrl(this.base, words, SEARCH_SHOWN), maxBytes: META_MAX_BYTES },
        { wait: SEARCH_WAIT },
      );
      const parsed = parseLocations(answer.text);
      locations = parsed.locations;
      more = parsed.next !== undefined;
    } catch (err) {
      if (err instanceof FormatError) return T.searchFailed({ code: 'format' });
      if (!(err instanceof FetchError)) throw err;
      if (err.code === 'busy') return T.searchBusy;
      this.failed('search', err);
      if (err.code === 'rate_limited') await this.saveState();
      return T.searchFailed({ code: err.code, status: err.status });
    }
    if (locations.size === 0) return T.searchNone(words.join(' '));
    const rows = [...locations].map(([id, l]) => ({
      id,
      text: [l.name || id, [l.siteType, l.state].filter(Boolean).join(', ')]
        .filter(Boolean)
        .join(' - '),
    }));
    return T.searchResults(rows, more);
  }

  // --- /data ---------------------------------------------------------------------------

  /** Writes /data, awaited SAVE_WAIT at most (the save goes on in the background). */
  async saveState() {
    if (!this.loaded || this.dataBlocked) return false;
    const data = {
      v: 1,
      lastAttemptAt: this.lastAttemptAt,
      readKey: this.readKey,
      lastOk: this.lastOk,
      pause: this.pause
        ? {
            until: this.pause.until,
            count: this.pause.count,
            code: this.pause.code,
            ...(this.pause.status !== undefined ? { status: this.pause.status } : {}),
          }
        : undefined,
      stations: [...this.stations.values()].slice(0, MAX_STATIONS * 2).map((e) => ({
        id: e.id,
        name: e.name,
        siteType: e.siteType,
        state: e.state,
        zone: e.zone,
        kinds: KINDS.filter((k) => e.kinds.has(k)),
        unknown: e.unknown,
        metaAt: e.metaAt,
        readAt: e.readAt,
      })),
      published: Object.fromEntries(this.published),
    };
    const job = Promise.resolve()
      .then(() => this.store.save(data))
      .then(
        () => {
          this.saveFailed = false;
          this.saveLate = false;
          return true;
        },
        (err) => {
          this.saveFailed = true;
          this.logger.warn(`/data not written (${err?.code ?? err?.name ?? 'Error'})`);
          return false;
        },
      );
    const done = await bounded(this.timers, job, SAVE_WAIT, 'late');
    if (done === 'late') {
      this.saveLate = true;
      this.logger.warn('/data is slow: not awaited');
      return false;
    }
    return done;
  }
}
