// -----------------------------------------------------------------------------
// Run by test/shutdown.test.js in a child process (argv[2]: a directory the
// test prepared, FIFOs made with mkfifo): FIFOs in place of the /data state
// file and of its temporary file, at a load, a save, a start and a stop of the
// app on the real file store. Each step is raced against a real 2 s timer
// ('hung' when it loses); the results go to stdout as JSON, then
// process.exit(0). A thread of the pool blocked in open() of a FIFO would
// hold process.exit() itself (libuv joins its threads at exit): the parent
// then sees this process still alive, and kills it. `node --test` also runs
// this file (every file under test/): without a directory, it does nothing.
// -----------------------------------------------------------------------------

import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileStore } from '../../src/store.js';
import { setup } from './app.js';

/** The outcome of a step: { ok: value } | { error: code } | 'hung' (still running after 2 s). */
async function within(work) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(work)
        .then(
          (value) => ({ ok: value ?? true }),
          (err) => ({ error: err?.code ?? err?.name ?? 'Error' }),
        ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('hung'), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const kindOf = async (path) => {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return 'absent';
  if (info.isFIFO()) return 'fifo';
  return info.isFile() ? 'file' : 'other';
};

async function run(dir) {
  const out = {};
  // a. The state file is a FIFO without a writer: unreadable, never waited on.
  out.load = await within(() => createFileStore(join(dir, 'a', 'state.json')).load());

  // b. The temporary file is a FIFO without a reader: the save is refused at once.
  out.saveNoReader = await within(() =>
    createFileStore(join(dir, 'b', 'state.json')).save({ a: 1 }),
  );
  out.saveNoReaderState = await kindOf(join(dir, 'b', 'state.json'));

  // b2. The same with a reader at the other end: refused before a byte is written.
  const reader = await open(
    join(dir, 'b', 'state.json.tmp'),
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  const fds = async () => (await readdir('/proc/self/fd')).length;
  const before = await fds();
  out.saveReader = await within(() => createFileStore(join(dir, 'b', 'state.json')).save({ a: 1 }));
  out.saveReaderFds = (await fds()) - before;
  out.readerGot = await reader.read(Buffer.alloc(64), 0, 64, null).then(
    ({ bytesRead }) => bytesRead,
    (err) => err.code,
  );
  await reader.close();
  out.saveReaderState = await kindOf(join(dir, 'b', 'state.json'));

  // c. A start then a stop of the app, the state file and its temporary file FIFOs.
  {
    const store = createFileStore(join(dir, 'c', 'state.json'));
    const t = await setup({ store, config: { stations: '01646500' } });
    out.cStart = await within(() => t.begin());
    out.cUnreadable = t.app.dataUnreadable;
    out.cStop = await within(() => t.app.stop());
    out.cSaveFailed = t.app.saveFailed;
    out.cFiles = (await readdir(join(dir, 'c'))).map((n) => n.replace(/-\d+$/, '-<time>')).sort();
  }

  // d. A valid state file, a FIFO as the temporary file: the stop signal (the
  // handler of src/wire.js, as the SDK runs it) ends at once, nothing written.
  {
    const store = createFileStore(join(dir, 'd', 'state.json'));
    const t = await setup({ store, config: { stations: '01646500' } });
    out.dStart = await within(() => t.begin());
    out.dUnreadable = t.app.dataUnreadable;
    out.dShutdown = await within(() => t.gladys.fake.shutdown('SIGTERM'));
    // The deadline of src/wire.js (a real timer here) never holds the process.
    out.dHeld = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    out.dSaveFailed = t.app.saveFailed;
    out.dState = await kindOf(join(dir, 'd', 'state.json'));
    out.dTmp = await kindOf(join(dir, 'd', 'state.json.tmp'));
  }
  return out;
}

const dir = process.argv[2];
if (dir) {
  const out = await run(dir);
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
}
