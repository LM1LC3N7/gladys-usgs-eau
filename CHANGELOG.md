# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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
