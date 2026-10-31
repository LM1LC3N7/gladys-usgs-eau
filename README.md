# gladys-usgs-eau

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for the
**U.S. rivers and groundwater** of the USGS monitoring stations: discharge,
gage height, water temperature and depth to groundwater, from the new USGS
Water Data OGC APIs (`api.waterdata.usgs.gov`, public domain). No account, no
key. Read-only. Not affiliated with the USGS; not a warning system.

Tried against the real USGS Water Data API on 2026-10-30 (public data,
captured as test fixtures); never tested with a real Gladys installation yet.
Reports are welcome.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Changes: [CHANGELOG.md](CHANGELOG.md). Open points: [TODO.md](TODO.md).
- Security: [SECURITY.md](SECURITY.md).

## How it works

- Up to 20 stations, read together in **one request** every 15 to 120 minutes
  (15 by default) from `latest-continuous`, never more often (the exceptions
  are in the user guide), the time of the read kept in /data; the names and
  time zones of the stations from `monitoring-locations` once a week (their failure never stops the values). One request at a time, bounded in time (20 s) and size, honest
  User-Agent.
- One Gladys device per station: discharge, gage height, water temperature and
  depth to groundwater (the kinds the station measures), in U.S. or metric
  units (exact conversions, the unit part of the feature key), and a status
  text in the time zone of the station.
- A measurement is published once (deduplicated on its time, kept in /data),
  only while younger than the maximum age of the form (3 h by default, against
  the `Date` of the answer), without `created_at`. A value the USGS does not
  give, or gives with a code that invalidates it (dry, ice, equipment, below
  the minimum...), unreadable or stale is never published: the status text
  says it; a code that only nuances it (estimated, revised...) is said there.
- 429: every request paused (5 min doubled, `Retry-After`, 60 s to 6 h, kept
  across restarts), the next read at the end of the pause. A 5xx of the values
  pauses the reads only; a 5xx of the names or of a search pauses nothing.
- A "Search stations" button finds the station numbers by words of the name.
- /data is only read and written as a regular file (a FIFO or a link in its
  place is never waited on); a stop ends 9 s after the signal at the latest,
  before the SIGKILL of Docker (10 s); nothing runs outside the process.

## Development

```bash
npm install
npm test               # node --test --test-timeout=60000
npm run lint
npm run format:check
npm run audit          # npm audit --omit=dev
npm run cover          # cover.png
```

Tests run against the SDK's fake Gladys, a scripted USGS on a virtual clock
(`test/helpers/app.js`), the real captures of `test/fixtures/` and a real local
HTTP server (`test/http.test.js`, real clock in `test/realclock.test.js`). See
[CLAUDE.md](CLAUDE.md) for the architecture and the rules.

## License

Apache-2.0 (see [LICENSE](LICENSE)). Data: USGS, public domain (see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
