# USGS Water Data

Unofficial integration, not affiliated with the U.S. Geological Survey (USGS).
It reads the **latest values of the USGS monitoring stations** you choose, in
the United States, from the new USGS Water Data APIs
(`api.waterdata.usgs.gov`, public domain): no account, no key. Read-only:
nothing is ever sent to the USGS but GET requests.

Tried against the real USGS Water Data API on 30 October 2026 (six stations:
rivers, a dry well, a groundwater well); never tested with a real Gladys
installation yet: tell us what you see.

This is **not a warning system**. Most values are **provisional** (the USGS
may revise them), measured every 15 minutes and sent about every hour. For
floods, follow the National Weather Service and your local authorities.

## Setup

1. Find the station numbers: the **Search stations** button of the
   configuration (words of the name, e.g. `potomac dc`), or the map at
   <https://waterdata.usgs.gov/>.
2. Type them in **Stations** (8 to 15 digits, separated by commas or spaces,
   20 at most). A station of another agency: its full id, such as
   `AR008-343826091361301`.
3. Pick the units, the language of the texts, the read interval (15 to 120
   minutes, 15 by default) and the maximum age (1 to 48 hours, 3 by default),
   then save.
4. After the first read, open the **Discovery** tab: one device per station,
   with the features of what the station measured recently. Create the ones you
   want.

## What you get

| Feature                           | U.S. units | Metric units | USGS parameter |
| --------------------------------- | ---------- | ------------ | -------------- |
| Discharge                         | ft³/s      | m³/s         | 00060          |
| Gage height                       | ft         | m            | 00065          |
| Water temperature                 | °F         | °C           | 00010          |
| Depth to water below land surface | ft         | m            | 72019          |
| Status                            | text       | text         |                |

- A feature is offered only once the station gave a current value of it.
- Conversions are exact (1 ft = 0.3048 m, 1 ft³/s = 0.028316846592 m³/s,
  °F = °C × 9/5 + 32), then rounded (0.001 for ft, ft³/s and m, 0.0001 for
  m³/s, 0.01 for degrees).
- The unit is part of the feature: a device keeps the units it was created
  with, even when the form changes them. To change units, delete the device and
  create it again from Discovery (the history of the old feature stays with
  it).
- Gladys has no unit for a flow: the discharge is a plain number, its unit in
  its name.
- The **Status** gives the time of the measurement in the time zone of the
  station (from the USGS: "Measured Oct 30, 1:50 AM EDT"), the kinds no longer
  current, or why there is no value: "No value (dry)", "No value (ice)",
  "Unreadable value at the source", "No current value; last one …",
  "No continuous data at this station", "Station unknown to the USGS".

## Freshness

- Each measurement is published **once** (deduplicated on its time, kept in
  /data), without a creation date: a scene "gage height above X" fires on a
  new measurement, not at every read.
- A measurement older than the **maximum age** of the form is not current: it
  is not published, the status says when it was measured. The age is counted
  from the `Date` of the USGS answer (from our clock when that header is
  missing or more than a day away from it), plus the time since the read.
- A value dated more than 15 minutes in the future, a value that is not a
  plain number (a text, an empty value), out of the plausible range of its kind
  (for example a "-999999") or in an unknown unit is unreadable: never
  published.
- A station that gives no value (the USGS sends none, with a reason such as
  `DRY`, `ICE`, `EQUIPMENT`) never gets a 0: the status gives the reason.
- A station with several series of one kind (two sensors, a series stopped in
  2019): among the current ones, the one of smallest series id (the same one from read to read while it stays current).
- Gladys keeps the last value published: when a value is no longer current,
  the **Status** says it; the value shown keeps its own date in Gladys.
- The status texts follow the ages at each read, and at every interval during a
  long pause.

## Flood thresholds and scenes

The USGS API gives no flood stage (the flood categories belong to the National
Weather Service). Use the thresholds you know for your river in a scene: the
**Device state change** trigger on the gage height or the discharge, with the
condition "greater than X". It fires on the first current measurement above X.

## Pace and requests

- **One request for all the stations** at every read (`latest-continuous`),
  followed by at most 2 more pages if the answer has some (never another
  address), then, once a week, one request for the names and time zones of the
  stations (`monitoring-locations`). One request at a time, the search button
  included.
- One read per interval, whatever asks: saving the form unchanged, a
  reconnection, the Discovery tab, a device created or a restart read nothing
  sooner (the time of the read is written to /data before the request).
  Exceptions:
  - the first start (no /data file yet) reads at once;
  - a **new station list** is read a minute after the last read at the
    earliest;
  - a read cut before its values came (the form saved, a reconnection) is
    read again a minute after it;
  - when /data cannot be read, or holds a date that is invalid or in the
    future, the first read comes one interval after the start;
  - an interval shortened in the form brings the next read closer (the new
    interval after the last read).
- Each request is bounded: 20 seconds, 2 MB for a page of values, 512 KB for
  the names or a search.
- User-Agent: `gladys-usgs-eau/<version> (+repository address)`; `Accept`
  `application/geo+json`. The USGS answers `no-cache` without ETag nor
  Last-Modified: no conditional request.
- **429** (too many requests): every request to the USGS is paused, 5 minutes
  doubled at each new one, `Retry-After` honoured, between 60 seconds and 6
  hours, kept across a restart; the next read comes at the end of the pause,
  not a round later. A **5xx** of the values pauses the reads the same way; a
  5xx of the names or of a search pauses nothing.
- A failure of the names and time zones never stops the values (a 429 is
  the limit of the whole service: it pauses every request, as above): the
  station number is then the name, the times are in UTC, they are tried again
  an hour later.
- Gladys accepts 300 states a minute: the module sends 250 at most over a
  rolling minute; beyond, the rest comes first at the next read, in turn.

## Search stations

The button asks the USGS for the stations whose name holds every word typed
(letters and digits only, 2 to 30 characters, 4 words at most) and lists 15 of
them with the number to copy. One search every 10 seconds at most, none during
a pause; a search waiting more than 45 seconds behind a read gives up.

## Status of the integration

"Connected" only when the last read succeeded **and** at least one station has
a current value. Otherwise the message says why: the USGS answers but no
station has a current value, the last read failed (network, no answer in time,
refused, answer too large, incomplete or unexpected), paused until a time
(UTC); and also stations typed that are not station numbers, a value of the
form replaced, stations unknown to the USGS, names not read, /data unreadable
(set aside under another name) or not writable, values put off to the next
read. Before the first read: "Waiting for the first read".

## Data and licence

- USGS data, in the public domain. Most real-time values are provisional.
- No personal data is read nor kept. /data keeps the time of the last read,
  the pause, the names, time zones and kinds of the stations, and the time of
  the last measurement published per feature.
