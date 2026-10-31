# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-31

### Added

- First version: the latest values of the USGS monitoring stations of the
  United States (up to 20), from the new Water Data OGC APIs
  (`api.waterdata.usgs.gov`): discharge, gage height, water temperature and
  depth to groundwater, in U.S. or metric units (exact conversions), and a
  status text per station in its time zone. One request for all the stations
  every 15 to 120 minutes (kept across restarts), names and time zones once a
  week (never blocking). Each measurement published once, only while younger
  than the maximum age of the form; a missing, unreadable or stale value never
  published as a number. 429 pauses every request (60 s to 6 h, kept across
  restarts), the next read at the end of the pause. A button finds the station
  numbers by name. Read-only.
- Review r1: the qualifiers of the USGS are read (the real codes): a value
  with a code that invalidates it (dry, ice, equipment, below the minimum,
  less than...) is never published, a code that only nuances it (estimated,
  revised...) and "provisional" are said in the status; discharge in m³/s
  (30208) read too; the version read from package.json; time zones follow
  daylight saving whatever the flag of the USGS (Florida), American Samoa;
  any Retry-After capped at 6 h; a 5xx pause said as such.
- Review r2: the status says "provisional" first, then the codes of each kind
  ("discharge: estimated") and the kinds late with their reason.
- Review r3: the process exits 9 s after a stop signal at the latest, before
  the SIGKILL of Docker (10 s), and never runs anything outside itself; /data
  is only read and written as a regular file, never waited on (a FIFO or a
  link in its place is unreadable or not writable); the status names each kind
  once ("discharge: provisional, estimated").

[Unreleased]: https://github.com/LM1LC3N7/gladys-usgs-eau/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-usgs-eau/releases/tag/v0.1.1
