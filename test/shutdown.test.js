// -----------------------------------------------------------------------------
// The stop of the container: Gladys stops it with Docker's default delay
// (dockerode `container.stop()` without `t`: SIGTERM, then SIGKILL 10 s
// later). The clean stop is bounded (the read running STOP_WAIT, the save of
// /data SAVE_WAIT), the process exits SHUTDOWN_LIMIT after the signal at the
// latest, and nothing of /data can hold the exit itself: a FIFO is never
// waited on (src/store.js). Nothing is ever run outside the process.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { WaterApp } from '../src/app.js';
import { SAVE_WAIT, SHUTDOWN_LIMIT, STOP_WAIT } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { wire } from '../src/wire.js';
import { settle, testClock } from './helpers/clock.js';
import {
  BASE,
  HOUR,
  MINUTE,
  NOW,
  SECOND,
  createSource,
  latestBody,
  locationsBody,
  quiet,
  series,
} from './helpers/app.js';

/** Docker's delay between the SIGTERM and the SIGKILL of `docker stop`, the one Gladys uses. */
const DOCKER_STOP_DELAY = 10 * SECOND;

/** The app wired as index.js does, the exits of the shutdown handler recorded instead of run. */
async function wired({ store = createMemoryStore(), app: given } = {}) {
  const clock = testClock({ start: NOW });
  const gladys = createFakeGladys({ selector: 'ue', config: { stations: '01646500' } });
  await gladys.connect();
  const source = createSource(clock, {
    latest: () => latestBody([series({ at: clock.now() - MINUTE })]),
    locations: () => locationsBody([{ id: 'USGS-01646500' }]),
  });
  const app =
    given ??
    new WaterApp({
      gladys,
      logger: quiet(),
      now: clock.now,
      monotonic: clock.monotonic,
      timers: clock.timers,
      store,
      fetchImpl: source.fetch,
      base: BASE,
    });
  const exits = [];
  wire(gladys, app, quiet(), { exit: (code) => exits.push(code), timers: clock.timers });
  gladys.removeAllListeners('connected');
  gladys.removeAllListeners('disconnected');
  return { clock, gladys, app, store, source, exits };
}

test('the deadline: after the clean stop at its longest, before the SIGKILL of Docker', () => {
  assert.equal(STOP_WAIT + SAVE_WAIT, 8 * SECOND);
  assert.equal(SHUTDOWN_LIMIT, 9 * SECOND);
  assert.ok(STOP_WAIT + SAVE_WAIT < SHUTDOWN_LIMIT, 'the clean stop is never cut');
  assert.ok(SHUTDOWN_LIMIT < DOCKER_STOP_DELAY, 'the process exits before Docker kills it');
});

test('a stop that never ends: the process exits 9 s after the signal, never later', async () => {
  const never = { stop: () => new Promise(() => {}), disconnected: async () => {} };
  const { clock, gladys, exits } = await wired({ app: never });
  void gladys.fake.shutdown('SIGTERM');
  await settle(10);
  await clock.advance(SHUTDOWN_LIMIT - 10);
  assert.deepEqual(exits, []);
  await clock.advance(20);
  assert.deepEqual(exits, [0]);
});

test('a stop signal runs the clean stop of the app (/data written) before the SDK exits', async () => {
  let stops = 0;
  let finish;
  const app = {
    disconnected: async () => {},
    stop: () => {
      stops += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const { clock, gladys, exits } = await wired({ app });
  let done = false;
  const shutdown = gladys.fake.shutdown('SIGTERM').then(() => {
    done = true;
  });
  await settle(10);
  assert.equal(stops, 1, 'app.stop called');
  await clock.advance(2 * SECOND);
  assert.equal(done, false, 'the SDK waits for the stop');
  assert.deepEqual(exits, []);
  finish();
  await shutdown;
  assert.equal(done, true);
  assert.deepEqual(exits, [], 'no forced exit after a clean stop');
});

test('/data frozen and a read held by it: the clean stop ends within 8 s, before the deadline', async () => {
  const store = createMemoryStore();
  const { clock, gladys, app, source, exits } = await wired({ store });
  await app.connected(() => gladys.getConfig());
  await settle(10);
  await clock.advance(0);
  await settle(10);
  await app.idle();
  assert.equal(source.count('latest'), 1);
  // /data freezes: the next read waits for the save of its attempt time.
  const saves = store.saves;
  store.hold = new Promise(() => {});
  await clock.advance(15 * MINUTE);
  await settle(10);
  assert.ok(app.busy, 'a read is running, held by /data');
  const start = clock.elapsed;
  let ended;
  const shutdown = gladys.fake.shutdown('SIGTERM').then(() => {
    ended = clock.elapsed - start;
  });
  for (let i = 0; i < 200 && ended === undefined; i += 1) {
    await clock.advance(50);
    await settle(5);
  }
  await shutdown;
  // The read awaited 3 s, the save of the stop 5 s: 8 s, the SDK disconnected.
  assert.ok(ended >= STOP_WAIT + SAVE_WAIT && ended <= STOP_WAIT + SAVE_WAIT + 100, `${ended}`);
  assert.ok(ended < SHUTDOWN_LIMIT);
  assert.deepEqual(exits, [], 'ended before the forced exit');
  assert.equal(store.saves, saves, 'nothing written to the frozen /data');
});

test('FIFOs in place of the /data files never block the process, at a start or at a stop', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'usgs-eau-fifo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const sub of ['a', 'b', 'c', 'd']) await mkdir(join(dir, sub));
  execFileSync('mkfifo', [
    join(dir, 'a', 'state.json'),
    join(dir, 'b', 'state.json.tmp'),
    join(dir, 'c', 'state.json'),
    join(dir, 'c', 'state.json.tmp'),
    join(dir, 'd', 'state.json.tmp'),
  ]);
  await writeFile(
    join(dir, 'd', 'state.json'),
    JSON.stringify({ v: 1, lastAttemptAt: NOW - HOUR }),
  );
  // In a child process: a thread of the pool blocked on a FIFO would hold
  // its exit (and this test file's, were it run here).
  const script = fileURLToPath(new URL('./helpers/fifo-child.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let timer;
  try {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const ended = await Promise.race([
      new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal }))),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('alive'), 20_000);
      }),
    ]);
    assert.notEqual(ended, 'alive', `the process could not exit (a thread blocked on a FIFO)`);
    assert.deepEqual(ended, { code: 0, signal: null }, stderr);
    assert.deepEqual(JSON.parse(stdout), {
      load: { ok: { ok: false, code: 'not_file' } },
      saveNoReader: { error: 'ENXIO' },
      saveNoReaderState: 'absent',
      saveReader: { error: 'not_file' },
      saveReaderFds: 0,
      readerGot: 0,
      saveReaderState: 'absent',
      cStart: { ok: true },
      cUnreadable: true,
      cStop: { ok: true },
      cSaveFailed: true,
      cFiles: ['state.json.tmp', 'state.json.unreadable-<time>'],
      dStart: { ok: true },
      dUnreadable: false,
      dShutdown: { ok: true },
      dHeld: 0,
      dSaveFailed: true,
      dState: 'file',
      dTmp: 'fifo',
    });
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
  }
});

test('no child process, worker nor signal to another process: nothing runs outside the process', async () => {
  const files = [
    'index.js',
    ...(await readdir(new URL('../src/', import.meta.url))).map((name) => `src/${name}`),
  ];
  assert.ok(files.includes('src/wire.js'));
  for (const file of files) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      text,
      /child_process|worker_threads|node:cluster|\bspawn\b|\bexecFile|\bfork\(|process\.kill|\/bin\/sh/,
      file,
    );
  }
});
