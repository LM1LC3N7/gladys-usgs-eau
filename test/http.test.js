// -----------------------------------------------------------------------------
// The only network access, against a real local HTTP server: headers sent,
// conditional answers, errors and pauses, size cut before the body is
// complete, strict UTF-8, timeout and abort.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FetchError, getText, parseRetryAfter } from '../src/http.js';

async function serve(t, handler) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req);
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}/f`, seen };
}

const get = (url, extra = {}) => getText({ url, accept: 'text/csv', maxBytes: 1024, ...extra });

const rejectsWith = (promise, code, status) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof FetchError);
    assert.equal(err.code, code);
    if (status) assert.equal(err.status, status);
    return true;
  });

test('a GET with an honest User-Agent and Accept, no cookie, no conditional header', async (t) => {
  const { url, seen } = await serve(t, (req, res) => {
    res.writeHead(200, { date: 'Fri, 30 Oct 2026 06:05:37 GMT', 'set-cookie': 'a=b' });
    res.end('{"type":"FeatureCollection"}');
  });
  const first = await get(url);
  assert.deepEqual(first, {
    status: 200,
    text: '{"type":"FeatureCollection"}',
    date: Date.UTC(2026, 9, 30, 6, 5, 37),
  });
  await get(url);
  assert.equal(seen[0].method, 'GET');
  assert.match(
    seen[0].headers['user-agent'],
    /^gladys-usgs-eau\/0\.1\.0 \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-usgs-eau\)$/,
  );
  assert.equal(seen[0].headers.accept, 'text/csv');
  assert.equal(seen[1].headers.cookie, undefined);
  assert.equal(seen[1].headers['if-none-match'], undefined);
  assert.equal(seen[1].headers['if-modified-since'], undefined);
  assert.equal(seen[0].headers['x-api-key'], undefined);
});

test('a 304 (never asked for) is not an answer', async (t) => {
  const { url } = await serve(t, (req, res) => {
    res.writeHead(304);
    res.end();
  });
  await rejectsWith(get(url), 'redirect', 304);
});

test('429 and 5xx carry their Retry-After; a redirect is never followed; 404 is an error', async (t) => {
  const answers = [
    [429, { 'retry-after': '120' }],
    [
      503,
      { 'retry-after': 'Thu, 29 Oct 2026 22:00:00 GMT', date: 'Thu, 29 Oct 2026 21:00:00 GMT' },
    ],
    [302, { location: 'http://elsewhere.test/' }],
    [404, {}],
  ];
  const { url, seen } = await serve(t, (req, res) => {
    const [status, headers] = answers[seen.length - 1];
    res.writeHead(status, headers);
    res.end('x');
  });
  await assert.rejects(
    get(url),
    (err) => err.code === 'rate_limited' && err.retryAfter === 120_000,
  );
  await assert.rejects(
    get(url),
    (err) => err.code === 'server' && err.status === 503 && err.retryAfter === 3600_000,
  );
  await rejectsWith(get(url), 'redirect', 302);
  await rejectsWith(get(url), 'http', 404);
  assert.equal(seen.length, 4);
});

test('an answer too large is cut before it is complete (with or without Content-Length)', async (t) => {
  let sent = 0;
  let closed = false;
  const { url } = await serve(t, (req, res) => {
    if (req.headers['x-mode'] === 'length') {
      res.writeHead(200, { 'content-length': '5000' });
      res.end('a'.repeat(5000));
      return;
    }
    res.writeHead(200);
    res.on('close', () => (closed = true));
    const timer = setInterval(() => {
      if (closed || sent > 1_000_000) {
        clearInterval(timer);
        res.end();
        return;
      }
      sent += 512;
      res.write('b'.repeat(512));
    }, 1);
  });
  await rejectsWith(
    getText({
      url,
      accept: 'x',
      maxBytes: 1024,
      fetchImpl: (u, init) =>
        fetch(u, { ...init, headers: { ...init.headers, 'x-mode': 'length' } }),
    }),
    'too_large',
  );
  await rejectsWith(get(url), 'too_large');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(sent < 100_000, `${sent} bytes sent before the cut`);
});

test('a body that is not UTF-8 is refused', async (t) => {
  const { url } = await serve(t, (req, res) => res.end(Buffer.from([0x41, 0xe9, 0x42])));
  await rejectsWith(get(url), 'encoding');
});

test('a server that never answers: timeout; an abort: aborted; a refused port: network', async (t) => {
  const { url } = await serve(t, () => {});
  await rejectsWith(get(url, { timeout: 100 }), 'timeout');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await rejectsWith(get(url, { signal: controller.signal, timeout: 5000 }), 'aborted');
  await rejectsWith(get('http://127.0.0.1:1/f'), 'network');
});

test('a body that stops coming is cut by the same timeout', async (t) => {
  const { url } = await serve(t, (req, res) => {
    res.writeHead(200);
    res.write('partial');
  });
  await rejectsWith(get(url, { timeout: 150 }), 'timeout');
});

test('Retry-After: seconds or an HTTP date, else nothing', () => {
  assert.equal(parseRetryAfter('30'), 30_000);
  assert.equal(parseRetryAfter('Thu, 29 Oct 2026 21:01:00 GMT', Date.UTC(2026, 9, 29, 21)), 60_000);
  assert.equal(parseRetryAfter('Thu, 29 Oct 2026 20:00:00 GMT', Date.UTC(2026, 9, 29, 21)), 0);
  assert.equal(parseRetryAfter('soon'), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter('-5'), undefined);
});

test('a declared length above the cap is refused before any byte is read', async (t) => {
  const { url } = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-length': '1000000' });
    res.write('x');
  });
  const started = performance.now();
  await rejectsWith(get(url, { timeout: 3000 }), 'too_large');
  assert.ok(performance.now() - started < 1000);
});

test('Retry-After: more than 7 digits of seconds is not a delay', () => {
  assert.equal(parseRetryAfter('1234567'), 1_234_567_000);
  assert.equal(parseRetryAfter('12345678'), undefined);
});
