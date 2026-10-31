// -----------------------------------------------------------------------------
// /data: no file is an empty state; a file that cannot be read is NOT (set
// aside under another name, never overwritten); saves go one after the other.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore, createMemoryStore } from '../src/store.js';
import { settle } from './helpers/clock.js';
import { HOUR, NOW, REAL_STATIONS, setup } from './helpers/app.js';

const dirOf = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'usgs-eau-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('no file yet: an empty state (said absent); a save then a load give it back', async (t) => {
  const file = join(await dirOf(t), 'state.json');
  const store = createFileStore(file);
  assert.deepEqual(await store.load(), { ok: true, data: {}, absent: true });
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
  assert.deepEqual(await store.load(), { ok: true, data: { a: 2 } });
});

test('a file that cannot be read is not an empty state', async (t) => {
  const dir = await dirOf(t);
  for (const [name, content] of [
    ['broken.json', '{"published":'],
    ['array.json', '[1,2]'],
    ['big.json', `{"x":"${'a'.repeat(1100 * 1024)}"}`],
  ]) {
    const file = join(dir, name);
    await writeFile(file, content);
    assert.equal((await createFileStore(file).load()).ok, false, name);
  }
  assert.deepEqual(
    await createFileStore(dir).load(),
    { ok: false, code: 'not_file' },
    'a directory',
  );
});

test('the app sets an unreadable /data file aside, keeps its bytes, then writes a new one', async (t) => {
  const dir = await dirOf(t);
  const file = join(dir, 'state.json');
  await writeFile(file, '{"published":{"x":');
  const { begin, app } = await setup({
    store: createFileStore(file),
    config: { stations: '01646500' },
  });
  await begin();
  const names = await readdir(dir);
  const aside = names.find((n) => n.startsWith('state.json.unreadable-'));
  assert.ok(aside, names.join(','));
  assert.equal(await readFile(join(dir, aside), 'utf8'), '{"published":{"x":');
  await app.stop();
  const fresh = JSON.parse(await readFile(file, 'utf8'));
  // Unreadable: as if read at the start (the first read one interval later).
  assert.ok(Math.abs(fresh.lastAttemptAt - NOW) < 1000);
});

test('what /data keeps: no personal data, bounded, nothing secret', async () => {
  const { begin, store, app, create } = await setup({ config: { stations: REAL_STATIONS } });
  await begin();
  await create('USGS-01646500');
  await app.stop();
  // As written to the file (JSON: an undefined field is left out).
  const data = JSON.parse(JSON.stringify(store.data));
  assert.deepEqual(Object.keys(data).sort(), [
    'lastAttemptAt',
    'lastOk',
    'published',
    'readKey',
    'stations',
    'v',
  ]);
  assert.equal(data.stations.length, 10);
  assert.deepEqual(data.stations[0], {
    id: 'USGS-01646500',
    name: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
    siteType: 'Stream',
    state: 'Maryland',
    zone: 'America/New_York',
    kinds: ['discharge', 'gage-height', 'water-temperature'],
    unknown: false,
    metaAt: data.stations[0].metaAt,
    readAt: data.stations[0].readAt,
  });
  assert.equal(Object.keys(data.published).length, 3);
});

test('rubbish in /data is dropped entry by entry', async () => {
  const store = createMemoryStore({
    lastAttemptAt: NOW - HOUR,
    pause: { until: 'x', count: 1, code: 'server' },
    stations: [
      { id: '../etc', name: 'x' },
      { id: '__proto__', name: 'x' },
      {
        id: 'USGS-01646500',
        name: 'A\u0000B',
        zone: '../../etc/passwd',
        kinds: ['discharge', 'evil', 'constructor'],
        metaAt: NOW + 10 * HOUR,
        readAt: 'x',
      },
      null,
      'x',
    ],
    published: { a: 1, b: 'x', ['__proto__']: 3 },
    readKey: 3,
    lastOk: NOW + HOUR,
  });
  const { app } = await setup({ store });
  await app.load();
  assert.equal(app.pause, undefined);
  assert.deepEqual([...app.stations.keys()], ['USGS-01646500']);
  const entry = app.stations.get('USGS-01646500');
  assert.equal(entry.name, 'A B');
  assert.equal(entry.zone, undefined);
  assert.deepEqual([...entry.kinds], ['discharge']);
  assert.equal(entry.metaAt, undefined, 'a date in the future is not believed');
  assert.equal(entry.readAt, undefined);
  assert.deepEqual([...app.published.keys()], ['a']);
  assert.equal(app.readKey, undefined);
  assert.equal(app.lastOk, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(app.lastAttemptAt, NOW - HOUR);
});

// A FIFO in place of the state file or of its temporary file: test/shutdown.test.js
// (in a child process: a thread blocked on a FIFO would hold the exit of this one).

test('a link in place of the state file or of its temporary file is never followed', async (t) => {
  const dir = await dirOf(t);
  const target = join(dir, 'elsewhere.json');
  await writeFile(target, '{"lastAttemptAt":1}');
  const file = join(dir, 'state.json');
  await symlink(target, file);
  assert.deepEqual(await createFileStore(file).load(), { ok: false, code: 'ELOOP' });
  const other = join(dir, 'other.json');
  await symlink(target, `${other}.tmp`);
  await assert.rejects(createFileStore(other).save({ a: 1 }), { code: 'ELOOP' });
  assert.equal(await readFile(target, 'utf8'), '{"lastAttemptAt":1}', 'the target untouched');
  assert.equal((await lstat(`${other}.tmp`)).isSymbolicLink(), true);
});

test('a temporary file left by a crash is replaced whole; every file closed', async (t) => {
  const dir = await dirOf(t);
  const file = join(dir, 'state.json');
  await writeFile(`${file}.tmp`, `{"left":"${'x'.repeat(1000)}"}`);
  const store = createFileStore(file);
  const fds = async () => (await readdir('/proc/self/fd')).length;
  const before = await fds();
  await store.save({ a: 0 });
  assert.deepEqual(await store.load(), { ok: true, data: { a: 0 } }, 'no byte of the old file');
  for (let i = 1; i < 5; i += 1) await store.save({ a: i });
  assert.equal(await fds(), before, 'no descriptor left open');
  assert.deepEqual(await store.load(), { ok: true, data: { a: 4 } });
  assert.equal(await fds(), before);
});

test('a directory in place of the temporary file: the save fails, nothing renamed', async (t) => {
  const dir = await dirOf(t);
  const file = join(dir, 'state.json');
  await writeFile(file, '{"a":0}');
  await mkdir(`${file}.tmp`);
  await assert.rejects(createFileStore(file).save({ a: 1 }));
  assert.equal(await readFile(file, 'utf8'), '{"a":0}');
});

test('a /data load that never ends is bounded: unreadable after 5 s, never empty', async () => {
  const store = {
    load: () => new Promise(() => {}),
    save: async () => {},
    setAside: async () => {},
  };
  const { app, gladys, wait, source } = await setup({ store, config: { stations: '01646500' } });
  const started = app.connected(() => gladys.getConfig());
  await settle(20);
  await wait(0);
  assert.equal(app.loaded, false);
  await wait(5000);
  await started;
  await wait(0);
  assert.equal(app.loaded, true);
  assert.equal(app.dataUnreadable, true);
  assert.equal(source.count('latest'), 0, 'the first read one interval later');
  await app.stop();
});
