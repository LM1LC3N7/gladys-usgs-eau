# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads the **latest values of USGS monitoring stations** (U.S. rivers and
groundwater) from the new Water Data OGC APIs (`api.waterdata.usgs.gov`,
public domain). Unofficial, not a warning system. **Read-only**: never
`onSetValue`, only GET requests. Never the legacy `waterservices.usgs.gov`.
Neighbour module: `gladys-swiss-hydro`; app, store and clock helpers taken from
`gladys-attente-frontiere` (approved, lot 19).

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
node --test --test-name-pattern "pause"   # tests whose name matches
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png, 800 x 534, plain Node
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                entry point: the SDK client, the app, src/wire.js, connect()
src/wire.js             the SDK handlers wired to the app (also used by the tests)
src/app.js              WaterApp: getConfig retries, pace, pause, reads, freshness, publication, status, search, /data
src/http.js             the only network access (GET, bounded in time and size, strict UTF-8)
src/usgs.js             URLs and answers of the USGS -> plain data, series choice, zones (pure)
src/devices.js          the devices, feature keys (kind + unit), conversions, external ids (pure)
src/store.js            what /data keeps across restarts (unreadable is not empty)
src/config.js           the form, normalized
src/constants.js        URLs, pacing, limits
src/i18n.js             runtime texts (en/fr)
test/helpers/app.js     the app on a fake Gladys, a scripted USGS and a virtual clock
test/helpers/clock.js   virtual and real clocks (copied from the test kit)
test/fixtures/          real captures of 2026-10-30
```

## Rules

- **External ids are forever**: `ext:<selector>:station:<agency>-<number>`,
  feature keys `discharge-cfs`, `discharge-m3s`, `gage-height-ft`,
  `gage-height-m`, `water-temperature-f`, `water-temperature-c`,
  `groundwater-depth-ft`, `groundwater-depth-m`, `status`. The unit is in the
  key: a value is only ever published in the unit of the feature it goes to.
- **Never a text as a number**: a null value (dry, ice...), a text, an empty
  value, a value out of range or in an unknown unit goes to the status only.
- **Freshness**: a measurement published once (its time in /data), only while
  younger than the maximum age (against the `Date` of the answer), without
  `created_at`. Stale data never makes the integration "connected".
- **Pace**: never two reads less than the interval apart (exceptions in the
  docs), the attempt time in /data before the request; one request at a time;
  429 pauses the host, a 5xx of the values the reads; a secondary endpoint
  never blocks. A timer a little early is armed again, never a skipped round.
- **Clocks**: `monotonic` for every timer, pace, pause, budget and age; the
  wall clock only for /data and an answer without a usable `Date` header.
- **/data**: every load, save and set-aside raced against 5 s.
- Units: only `DEVICE_FEATURE_UNITS_BY_CATEGORY` of the core.
- **Versions belong to the Release workflow**; `test/manifest.test.js` checks
  they agree. **Changelog** under `## [Unreleased]`. **User-facing text**
  bilingual (en/fr), docs in sync with the code.
- **Style**: Prettier, ESLint; comments in English explain why; tests never
  touch the network beyond 127.0.0.1; a real-clock test stops the app in a
  `finally`.
