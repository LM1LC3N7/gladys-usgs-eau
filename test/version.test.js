// The version is read from package.json (which the release bumps), never
// hard-coded: a copy of the module next to a package.json at another version
// must report that version (taken from gladys-attente-frontiere 2ca7728).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('the version and the User-Agent follow the package.json next to the module', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'usgs-eau-version-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '9.8.7' }));
  const source = await readFile(new URL('../src/constants.js', import.meta.url), 'utf8');
  await writeFile(join(dir, 'src', 'constants.js'), source);
  const copy = await import(new URL(`file://${join(dir, 'src', 'constants.js')}`).href);
  assert.equal(copy.VERSION, '9.8.7');
  assert.equal(
    copy.USER_AGENT,
    'gladys-usgs-eau/9.8.7 (+https://github.com/LM1LC3N7/gladys-usgs-eau)',
  );
});
