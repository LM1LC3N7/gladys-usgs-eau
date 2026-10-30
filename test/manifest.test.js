// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  INTERVAL_MAX_MIN,
  INTERVAL_MIN_MIN,
  MAX_AGE_MAX_H,
  MAX_AGE_MIN_H,
  USER_AGENT,
  VERSION,
} from '../src/constants.js';
import { FEATURES, KINDS, buildDevice, validId } from '../src/devices.js';
import { FEATURE_NAMES } from '../src/i18n.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');
const wiring = read('src/wire.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const fakeGladys = {
  externalIds: (type, id) => ({
    device: `ext:x:${type}:${id}`,
    feature: (key) => `ext:x:${type}:${id}:${key}`,
  }),
};
const devices = ['us', 'metric'].flatMap((units) =>
  ['en', 'fr'].map((language) =>
    buildDevice(
      fakeGladys,
      { id: 'USGS-01646500', name: 'POTOMAC RIVER', kinds: KINDS },
      { units, language },
    ),
  ),
);

test('the store basics; one semver version in 4 places (and the User-Agent), never pinned here', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length <= 30, 'the store caps the name at 30 characters');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-usgs-eau:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(VERSION, pkg.version);
  assert.equal(
    USER_AGENT,
    `gladys-usgs-eau/${pkg.version} (+https://github.com/LM1LC3N7/gladys-usgs-eau)`,
  );
  assert.equal(pkg.name, 'gladys-usgs-eau');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^0\.16\.\d+$/);
  assert.deepEqual(manifest.categories, ['environment']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.ok(!('keywords' in manifest) && !('countries' in manifest), 'in TODO.md for later');
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-usgs-eau\//,
  );
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /^Unofficial/);
  assert.match(manifest.description.fr, /^Non officiel/);
});

test('the cover is an 800 x 534 PNG', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('the docs say how it was tested, that it is no warning system, and where the data comes from', () => {
  const fr = read('docs/fr.md');
  const en = read('docs/en.md');
  assert.match(fr, /Essayée contre la vraie API Water Data de l'USGS/);
  assert.match(en, /Tried against the real USGS Water Data API/);
  assert.match(fr, /jamais testée avec une\s+vraie installation Gladys/);
  assert.match(en, /never tested with a real Gladys\s+installation/);
  assert.match(fr, /pas un système d'alerte/);
  assert.match(en, /not a warning system/);
  assert.match(fr, /provisoires/);
  assert.match(en, /provisional/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /public domain/);
  assert.match(read('README.md'), /api\.waterdata\.usgs\.gov/);
  for (const file of ['docs/fr.md', 'docs/en.md', 'README.md', 'src/constants.js']) {
    assert.doesNotMatch(read(file), /waterservices\.usgs\.gov\/nwis/, file);
  }
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('the configuration matches the code; nothing secret', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), [
    'intro',
    'stations',
    'units',
    'language',
    'interval_minutes',
    'max_age_hours',
  ]);
  for (const key of Object.keys(fields)) {
    assert.ok(!key.startsWith('gladys_'), `${key}: never prefixed gladys_`);
  }
  assert.equal(manifest.config_schema.filter((f) => f.type === 'secret').length, 0);
  for (const key of ['stations', 'units', 'language', 'interval_minutes', 'max_age_hours']) {
    assert.equal(fields[key].default, DEFAULT_CONFIG[key], key);
    assert.equal(fields[key].required, false, key);
  }
  assert.deepEqual(
    fields.units.options.map((o) => o.value),
    ['us', 'metric'],
  );
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    ['en', 'fr'],
  );
  assert.equal(fields.interval_minutes.min, INTERVAL_MIN_MIN);
  assert.equal(fields.interval_minutes.max, INTERVAL_MAX_MIN);
  assert.equal(fields.max_age_hours.min, MAX_AGE_MIN_H);
  assert.equal(fields.max_age_hours.max, MAX_AGE_MAX_H);
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    ['search_stations'],
  );
  const search = manifest.actions[0];
  assert.ok(search.timeout_seconds >= 50 && search.timeout_seconds <= 120);
  assert.deepEqual(
    search.fields.map((f) => [f.key, f.type, f.required]),
    [['query', 'string', true]],
  );
  assert.ok(!('scene_triggers' in manifest) && !('widgets' in manifest));
});

test('the wiring: read-only, getConfig retried by the app, the lifecycle and the button wired', () => {
  assert.match(index, /wire\(gladys, app, logger\);\n\nlogger\.info[\s\S]*gladys\.connect\(\)/);
  for (const code of [index, wiring]) {
    assert.ok(!code.includes('onSetValue'), 'no command: read-only');
    assert.ok(!code.includes('onPoll'), 'the app reads at its own pace');
  }
  assert.match(wiring, /\.connected\(\(\) => gladys\.getConfig\(\)\)/);
  assert.match(wiring, /onAction\('search_stations', \(fields\) => app\.search\(fields\)\)/);
  for (const handler of [
    'onScanRequest',
    'onDeviceCreated',
    'onConfigUpdated',
    "on('disconnected'",
    'handleShutdown',
  ]) {
    assert.ok(wiring.includes(handler), handler);
  }
  const strip = (code) => code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const http = strip(read('src/http.js'));
  assert.match(http, /method: 'GET'/);
  assert.match(http, /redirect: 'manual'/);
  assert.match(http, /credentials: 'omit'/);
  assert.ok(!/Mozilla|Chrome|Safari/.test(read('src/constants.js')), 'never a browser User-Agent');
  assert.match(read('src/constants.js'), /'https:\/\/api\.waterdata\.usgs\.gov\/ogcapi\/v1'/);
});

test('the devices: core units only, nothing writable, no switch, no poll; names in both languages', () => {
  for (const device of devices) {
    assert.equal(device.should_poll, false);
    assert.ok(!('poll_frequency' in device));
    for (const feature of device.features) {
      assert.equal(feature.read_only, true);
      assert.equal(feature.has_feedback, false);
      assert.notEqual(feature.category, 'switch');
      assert.notEqual(feature.type, 'binary');
      assert.ok(feature.min <= feature.max);
      assert.ok(!/[.]|:$/.test(feature.external_id.split(':').pop()));
    }
  }
  assert.deepEqual(
    devices[0].features.map((f) => [f.external_id.split(':').pop(), f.category, f.unit ?? null]),
    [
      ['discharge-cfs', 'unknown', null],
      ['gage-height-ft', 'level-sensor', 'feet'],
      ['water-temperature-f', 'temperature-sensor', 'fahrenheit'],
      ['groundwater-depth-ft', 'level-sensor', 'feet'],
      ['status', 'text', null],
    ],
  );
  assert.deepEqual(
    devices[2].features.map((f) => [f.external_id.split(':').pop(), f.unit ?? null]),
    [
      ['discharge-m3s', null],
      ['gage-height-m', 'm'],
      ['water-temperature-c', 'celsius'],
      ['groundwater-depth-m', 'm'],
      ['status', null],
    ],
  );
  assert.equal(devices[0].name, 'POTOMAC RIVER (USGS-01646500)');
  for (const lang of ['en', 'fr']) {
    for (const key of [...FEATURES.keys(), 'status']) {
      assert.ok(FEATURE_NAMES[lang][key], `${lang} ${key}`);
    }
  }
});

test('the units are in the list of the core for their category', () => {
  const core = new URL('../../../Gladys/server/utils/constants.js', import.meta.url);
  if (!existsSync(core)) return;
  const constants = createRequire(core)(core.pathname);
  for (const feature of devices.flatMap((d) => d.features)) {
    if (feature.unit === undefined) continue;
    const allowed = constants.DEVICE_FEATURE_UNITS_BY_CATEGORY[feature.category];
    assert.ok(allowed?.includes(feature.unit), `${feature.category} ${feature.unit}`);
  }
});

test('supported_options of every published feature pass the rules of the core', () => {
  const core = new URL(
    '../../../Gladys/server/utils/normalizeSupportedOptions.js',
    import.meta.url,
  );
  let normalize;
  if (existsSync(core)) {
    try {
      normalize = createRequire(core)(core.pathname);
    } catch {
      normalize = undefined;
    }
  }
  let count = 0;
  for (const feature of devices.flatMap((d) => d.features)) {
    const options = feature.supported_options;
    if (options === undefined) continue;
    count += 1;
    const values = options.map((o) => `${o.value}`);
    assert.equal(new Set(values).size, values.length, 'unique values');
    for (const o of options) {
      assert.equal(typeof o.label, 'string');
      assert.ok(o.label.trim() !== '' && o.label === o.label.trim(), 'plain label');
      assert.deepEqual(Object.keys(o).sort(), ['label', 'value']);
    }
    if (typeof normalize === 'function') normalize(feature);
  }
  // This integration publishes no select today: the rule holds for any added later.
  assert.equal(count, 0);
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
});

test('the code never feeds the energy endpoints nor scene events', () => {
  for (const file of ['index.js', 'src/wire.js', 'src/app.js', 'src/devices.js']) {
    assert.doesNotMatch(read(file), /publishEnergyConsumption\(/, file);
    assert.doesNotMatch(read(file), /publishSceneEvent\(/, file);
  }
});

test('external ids: never a dot, a colon nor a slash, whatever /data says', () => {
  for (const bad of [
    'USGS-0164.6500',
    'USGS:01646500',
    '../01646500',
    'USGS/01646500',
    'usgs-01646500',
    'USGS-1646500',
    '',
    '__proto__',
  ]) {
    assert.equal(validId(bad), false, bad);
  }
  assert.equal(validId('USGS-01646500'), true);
  assert.equal(validId('AR008-343826091361301'), true);
});
