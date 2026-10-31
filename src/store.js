// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container): the
// time of the last read (the pace survives a restart), the pause of the
// source after a 429/5xx, the stations seen (Discovery after a restart, their
// names and time zones), and the source date of the last value published per
// feature (never the same reading twice). Nothing
// personal, nothing secret. A small JSON file written through a temporary
// file and a rename, one save after the other. Taken from gladys-droplet
// (approved): a file that exists but cannot be read is NOT an empty state;
// here it is set aside (renamed, never overwritten) and the app starts in
// "baseline" mode (src/app.js).
// -----------------------------------------------------------------------------

import { constants } from 'node:fs';
import { open, rename, writeFile } from 'node:fs/promises';

export const DEFAULT_STATE_FILE = '/data/usgs-eau-state.json';
/** A larger file is not ours: unreadable (never taken for an empty state). */
const MAX_STATE_BYTES = 1024 * 1024;

const isPlain = (data) => Boolean(data) && typeof data === 'object' && !Array.isArray(data);

/**
 * @returns {{ load(): Promise<{ ok: true, data: object } | { ok: false, code: string }>,
 *   save(data: object): Promise<void>, setAside(stamp: number): Promise<void> }}
 */
export function createFileStore(file = DEFAULT_STATE_FILE) {
  /** The saves one after the other: two never share the temporary file. */
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  };
  return {
    /**
     * Asynchronous and bounded: the app also races it against a timer (a FIFO
     * or a frozen mount never blocks the process). At most MAX_STATE_BYTES + 1
     * bytes are read.
     */
    async load() {
      let handle;
      try {
        handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
        const info = await handle.stat();
        if (!info.isFile()) return { ok: false, code: 'not_file' };
        if (info.size > MAX_STATE_BYTES) return { ok: false, code: 'too_large' };
        const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
        let size = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
          if (bytesRead === 0) break;
          size += bytesRead;
          if (size > MAX_STATE_BYTES) return { ok: false, code: 'too_large' };
        }
        const data = JSON.parse(buffer.subarray(0, size).toString('utf8'));
        return isPlain(data) ? { ok: true, data } : { ok: false, code: 'not_state' };
      } catch (err) {
        // No file yet (first start): an empty state. Anything else is not.
        if (err?.code === 'ENOENT') {
          return { ok: true, data: {}, absent: true };
        }
        return {
          ok: false,
          code: typeof err?.code === 'string' ? err.code.slice(0, 20) : 'not_state',
        };
      } finally {
        await handle?.close().catch(() => {});
      }
    },
    save(data) {
      const job = queue.then(
        () => write(data),
        () => write(data),
      );
      queue = job.catch(() => {});
      return job;
    },
    /** Keeps an unreadable file under another name (for a human to look at). */
    setAside(stamp) {
      const job = queue.then(() => rename(file, `${file}.unreadable-${Math.floor(stamp)}`));
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests): `broken` makes load fail, `failSave` makes save fail. */
export function createMemoryStore(initial = {}) {
  let data = structuredClone(initial);
  const store = {
    broken: false,
    failSave: false,
    failAside: false,
    saves: 0,
    asides: 0,
    /** A promise to await before each save resolves (a slow /data). */
    hold: undefined,
    /** A promise to await before load resolves (a frozen /data). */
    holdLoad: undefined,
    async load() {
      if (store.holdLoad) await store.holdLoad;
      if (store.broken) return { ok: false, code: 'EIO' };
      if (store.absent) return { ok: true, data: {}, absent: true };
      return { ok: true, data: structuredClone(data) };
    },
    absent: Object.keys(initial).length === 0,
    async save(next) {
      if (store.hold) await store.hold;
      if (store.failSave) {
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
      }
      store.saves += 1;
      store.absent = false;
      data = structuredClone(next);
    },
    /** A promise to await before setAside resolves (a slow /data). */
    holdAside: undefined,
    async setAside() {
      if (store.holdAside) await store.holdAside;
      if (store.failAside) throw Object.assign(new Error('read-only'), { code: 'EROFS' });
      store.asides += 1;
      store.broken = false;
      store.absent = true;
      data = {};
    },
    get data() {
      return data;
    },
  };
  return store;
}
