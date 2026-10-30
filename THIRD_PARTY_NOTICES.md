# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
ships no third-party code besides its npm dependencies (the Gladys integration
SDK, Apache-2.0). No library was ported: the request shapes and fields were
read from the USGS documentation of the Water Data OGC APIs, from the answers
of the service, and from the `waterdata` module of the reference library
`dataretrieval` (Python, by the USGS, public domain in the United States and
CC0-1.0 elsewhere, version of 2026-10-29), read only.

## U.S. Geological Survey: Water Data OGC APIs

<https://api.waterdata.usgs.gov/docs/ogcapi/> (collections `latest-continuous`
and `monitoring-locations`, read at run time).

USGS-authored or produced data and information are in the public domain
(<https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits>).
Most real-time values are provisional and subject to revision
(<https://waterdata.usgs.gov/provisional-data-statement/>).

The test fixtures in `test/fixtures/` are copies of two answers of the service
of 2026-10-30 (public data of six monitoring locations, nothing personal in
them).
