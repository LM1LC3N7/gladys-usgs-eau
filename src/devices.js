// -----------------------------------------------------------------------------
// The devices offered in Discovery (pure): one per station.
//
// External ids, forever:
//   device:  ext:<selector>:station:<agency>-<site number>   (USGS-01646500)
//   feature: <device>:<key>, the key naming the kind AND the unit:
//     discharge-cfs / discharge-m3s, gage-height-ft / gage-height-m,
//     water-temperature-f / water-temperature-c,
//     groundwater-depth-ft / groundwater-depth-m, status.
// The unit is part of the key: a device created in one unit system keeps
// receiving values in that unit, whatever the form says later (a value is
// never published in a unit its feature does not show). Read-only, no poll by
// Gladys: the app reads the source itself at its own pace.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TY,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { STATION_ID } from './config.js';
import { BOUNDS, CUBIC_FOOT, FOOT } from './usgs.js';
import { FEATURE_NAMES } from './i18n.js';

export const DEVICE_TYPE = 'station';

/** The kinds in the order of the features. */
export const KINDS = ['discharge', 'gage-height', 'water-temperature', 'groundwater-depth'];

const round = (value, decimals) => {
  const factor = 10 ** decimals;
  const out = Math.round(value * factor) / factor;
  return Object.is(out, -0) ? 0 : out;
};

/**
 * Every value feature, by key: its kind, unit system, Gladys category, type
 * and unit (only the units the core lists for the category: the core has no
 * flow unit, so the discharge is a plain value, its unit in its name), and the
 * conversion from the canonical unit (cfs, ft, °C), exact then rounded.
 */
export const FEATURES = new Map([
  [
    'discharge-cfs',
    {
      kind: 'discharge',
      system: 'us',
      category: C.UNKNOWN,
      type: TY.UNKNOWN.UNKNOWN,
      convert: (v) => round(v, 3),
    },
  ],
  [
    'discharge-m3s',
    {
      kind: 'discharge',
      system: 'metric',
      category: C.UNKNOWN,
      type: TY.UNKNOWN.UNKNOWN,
      convert: (v) => round(v * CUBIC_FOOT, 4),
    },
  ],
  [
    'gage-height-ft',
    {
      kind: 'gage-height',
      system: 'us',
      category: C.LEVEL_SENSOR,
      type: TY.LEVEL_SENSOR.LIQUID_DEPTH,
      unit: U.FEET,
      convert: (v) => round(v, 3),
    },
  ],
  [
    'gage-height-m',
    {
      kind: 'gage-height',
      system: 'metric',
      category: C.LEVEL_SENSOR,
      type: TY.LEVEL_SENSOR.LIQUID_DEPTH,
      unit: U.M,
      convert: (v) => round(v * FOOT, 3),
    },
  ],
  [
    'water-temperature-f',
    {
      kind: 'water-temperature',
      system: 'us',
      category: C.TEMPERATURE_SENSOR,
      // `probe`: kept out of the room temperatures of Gladys.
      type: TY.TEMPERATURE_SENSOR.PROBE,
      unit: U.FAHRENHEIT,
      convert: (v) => round((v * 9) / 5 + 32, 2),
    },
  ],
  [
    'water-temperature-c',
    {
      kind: 'water-temperature',
      system: 'metric',
      category: C.TEMPERATURE_SENSOR,
      type: TY.TEMPERATURE_SENSOR.PROBE,
      unit: U.CELSIUS,
      convert: (v) => round(v, 2),
    },
  ],
  [
    'groundwater-depth-ft',
    {
      kind: 'groundwater-depth',
      system: 'us',
      category: C.LEVEL_SENSOR,
      type: TY.LEVEL_SENSOR.LIQUID_DEPTH,
      unit: U.FEET,
      convert: (v) => round(v, 3),
    },
  ],
  [
    'groundwater-depth-m',
    {
      kind: 'groundwater-depth',
      system: 'metric',
      category: C.LEVEL_SENSOR,
      type: TY.LEVEL_SENSOR.LIQUID_DEPTH,
      unit: U.M,
      convert: (v) => round(v * FOOT, 3),
    },
  ],
]);

/** The feature key of a kind in a unit system. */
export function keyOf(kind, system) {
  for (const [key, def] of FEATURES) {
    if (def.kind === kind && def.system === system) return key;
  }
  return undefined;
}

/** Whether an id is a valid station id (no `.`, `:` nor anything else). */
export const validId = (id) => typeof id === 'string' && STATION_ID.test(id);

export const idsOf = (gladys, id) => gladys.externalIds(DEVICE_TYPE, id);

/**
 * The device of a station: the value features of the kinds seen at it (in
 * the unit system of the form), then the status text.
 * @param {{ id: string, name?: string, kinds: Iterable<string> }} entry
 */
export function buildDevice(gladys, entry, { units, language }) {
  const ids = idsOf(gladys, entry.id);
  const names = FEATURE_NAMES[language] ?? FEATURE_NAMES.en;
  const seen = new Set(entry.kinds);
  const features = [];
  for (const kind of KINDS) {
    if (!seen.has(kind)) continue;
    const key = keyOf(kind, units);
    const def = FEATURES.get(key);
    const [min, max] = BOUNDS[kind];
    features.push({
      name: names[key],
      external_id: ids.feature(key),
      category: def.category,
      type: def.type,
      ...(def.unit ? { unit: def.unit } : {}),
      min: Math.ceil(def.convert(min)),
      max: Math.floor(def.convert(max)),
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
  }
  features.push({
    name: names.status,
    external_id: ids.feature('status'),
    category: C.TEXT,
    type: TY.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
    has_feedback: false,
    keep_history: false,
  });
  const name = entry.name ? `${entry.name} (${entry.id})` : entry.id;
  return {
    name: name.slice(0, 120),
    external_id: ids.device,
    should_poll: false,
    features,
  };
}

/** The device external id -> the station id, for the devices of this integration. */
export function parseDeviceId(gladys, externalId) {
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) return undefined;
  const id = externalId.slice(prefix.length);
  return validId(id) ? id : undefined;
}
