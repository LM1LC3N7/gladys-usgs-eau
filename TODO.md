# TODO

## Before announcing

- [ ] Review r1 (high).
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic at publication only.

## To watch on the real service

- [ ] The qualifier codes of `latest-continuous`: `DRY`, `DISCONTINUED`, `ICE`,
      `ESTIMATED` seen or documented; the others are shown as their code.
- [ ] The units of `unit_of_measure`: `ft^3/s`, `ft`, `degC` seen; `m^3/s`,
      `m`, `degF` accepted by guess; anything else is unreadable (status).
- [ ] The anonymous rate limit of api.data.gov for this API (not published;
      one request per interval, plus one a week for the names).
- [ ] The `v1` path of the OGC APIs (the `v0` one answers the same today).

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, `docker_image`).
- SDK `^0.16.0` (the template's; the latest published, checked on the
  registry on 2026-10-30). No other runtime dependency.
- Manifest: `categories: ["environment"]` (open-data daily-life feeds, §3 of
  the catalog spec), `transports: ["cloud"]`, `gladys_version: ">=5.1.0"`; no
  `keywords` / `countries` yet (to add when the core accepts them: `US`).
- Only the new USGS Water Data OGC APIs (`api.waterdata.usgs.gov/ogcapi/v1`),
  never the legacy `waterservices.usgs.gov` being retired. Reference library
  `dataretrieval` (USGS, public domain / CC0-1.0, cloned read-only in
  `~/code/ref/lot19/dataretrieval-python`): request shapes only, nothing ported.
- No API key: one request per interval for all the stations is far under any
  limit; the optional api.data.gov key would add a secret for nothing. To add
  if users hit 429 (header `X-Api-Key`, never in the URL).
- No flood thresholds: the USGS API has no flood stage (they are the National
  Weather Service's). Scenes use the core trigger "device state above X" on the
  gage height or the discharge (said in the docs). NWS flood categories (NWPS
  API) would be a second source: for later, Louis's call.
- No scene trigger, scene action nor widget: the values are device features,
  the core triggers and widgets cover them.
- Kinds read: discharge (00060), gage height (00065), water temperature
  (00010), depth to water below land surface (72019); statistic 00011
  (instantaneous) or none. Plausible ranges (canonical units): discharge
  -500 000 to 10 000 000 ft³/s (tidal stations flow backwards), gage height
  -500 to 20 000 ft, depth -1 000 to 10 000 ft, temperature -5 to 50 °C.
- Units: a form choice (U.S. by default, the units of the source; metric
  converted exactly); the unit is part of the feature key
  (`discharge-cfs`/`discharge-m3s`...) so that a device created in one system
  never receives values of the other. The core has no flow unit: discharge is
  `unknown`, its unit in its name.
- Several series of one kind at a station: among the current ones, the one of
  smallest `time_series_id` (stable; the latest one would let two sensors
  alternate).
- Freshness: maximum age from the form (1 to 48 h, 3 by default), counted from
  the `Date` of the answer (within a day of our clock), plus the monotonic time
  since the read; 15 min of future tolerated. Each measurement published once
  (time kept in /data), without `created_at`.
- A device lists the kinds the station gave a current value of (kept in /data,
  never removed: a feature that disappears would lose its history).
- Time zone of a station from `time_zone_abbreviation` and
  `uses_daylight_savings` (EST/CST/MST/PST/AKST/HST/AST/ChST/SST -> IANA);
  unknown: UTC. The instants of the API carry their offset: no local time to
  guess, a change of time only changes the display.
- Connection status "connected" only when the last read succeeded and at least
  one station has a current value (a service that answers with stale data is
  not "up to date").
- Pace: interval 15 to 120 min (default 15), one read at a time, the next one
  armed before anything is awaited; /data saves awaited 5 s at most; a new
  station list read a minute after the last read at the earliest. A /data that
  cannot be read, or a date in it invalid or in the future: the first read one
  interval after the start (lesson of DriveBC r1, I3). First start: at once.
- A timer that fires up to 1 s early is armed again for the rest: never a read
  sooner, never a round skipped (lesson of DriveBC r1, I2). During a pause
  longer than the interval, the app wakes every interval to refresh the status
  texts (no request), and reads at the end of the pause.
- 429: pause of every request to the host (its rate limit is per host); 5xx of
  the values: pause of the reads; 5xx of the names or of a search: no pause
  (a secondary endpoint never blocks). 5 min doubled, `Retry-After` honoured,
  60 s to 6 h, in /data; an ended pause keeps its count until a success.
- Pages: `next` followed only on the same endpoint, 3 pages at most; beyond, or
  a link elsewhere: "incomplete", nothing new published.
- Format guard: answers with series but none readable (renamed fields, unknown
  units or parameters only) are an error, never "no data".
- /data unreadable: renamed aside (`.unreadable-<time>`), never overwritten;
  the values present at the first read after it are taken as already published
  (a baseline). If it cannot be set aside, /data is never written.
- State budget: 250 states per rolling minute (the core accepts 300); the rest
  at the next read, in turn, said in the status.
- Search: words of letters and digits only (nothing else reaches the CQL
  filter), 4 at most; one search every 10 s, none during a pause, queued behind
  a read (one request at a time) and dropped if not started within 45 s.
- A read cut before its values came (a save of the form, a reconnection) is
  read again a minute after it (a round is never lost); a read cut after its
  values (during the publication) is not. A wake-up that finds a read or a
  refresh running is armed again as soon as it ends (a minute at the latest).
- Mutation: about 165 mutants of the guards (app, usgs, config, devices, http,
  i18n, store) in a directory of my own, all killed by a test but one
  equivalent: the size check before reading /data (`store.js`, S2: the read
  loop stops at the same 1 MB with the same `too_large`). Redundant code found
  by survivors removed rather than tested (a check of `ignored === total`
  implied by `usable === 0`, an unreachable `aborted` branch, a re-arm in
  `failed()` already done by the wake-up, a length check before an anchored
  regex).
- Real-clock tests: ×20 for the period (two reads, 15 min = 45 s); ×60 for the
  read at the end of a 20 min pause (20 s), so that each fits in the 60 s test
  timeout.

## Later

- Optional api.data.gov key (if 429s show up).
- NWS flood categories for the stations that have some (another source).
- Daily statistics (percentiles) when the USGS statistics API leaves v0.
