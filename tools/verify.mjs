import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'mirror-manifest.json'), 'utf8'));
for (const record of manifest.files) {
  const data = fs.readFileSync(path.join(root, record.file));
  assert.equal(crypto.createHash('sha256').update(data).digest('hex'), record.localSha256 || record.sha256, `File integrity: ${record.file}`);
}
const chart = JSON.parse(fs.readFileSync(path.join(root, 'public/chart.json'), 'utf8'));
assert.ok(chart.notes.length > 0, 'Chart must contain notes');
chart.notes.forEach((note, i) => {
  assert.ok(Number.isFinite(note.time) && note.time >= 0 && note.time <= 85, `Note time ${i}`);
  assert.ok(Number.isInteger(note.lane) && note.lane >= 0 && note.lane < 4, `Note lane ${i}`);
  if (i) assert.ok(note.time >= chart.notes[i - 1].time, `Chart order ${i}`);
});
console.log(`Integrity verified: ${manifest.files.length} files, ${chart.notes.length} notes.`);

const child = spawn(process.execPath, [path.join(root, 'server.mjs')], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout')), 10000);
    child.once('error', reject);
    child.stdout.on('data', data => {
      const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.stderr.on('data', data => reject(new Error(data.toString())));
  });
  for (const record of manifest.files) {
    const response = await fetch(`${base}/fluffyrhythm/${record.file.slice('public/'.length)}`, { method: 'HEAD' });
    assert.equal(response.status, 200, record.file);
    assert.equal(Number(response.headers.get('content-length')), fs.statSync(path.join(root, record.file)).size, record.file);
  }
  const audioUrl = `${base}/fluffyrhythm/assets/audio/naru-game-preroll-v19.mp3`;
  const partial = await fetch(audioUrl, { headers: { Range: 'bytes=0-63' } });
  assert.equal(partial.status, 206);
  assert.equal((await partial.arrayBuffer()).byteLength, 64);
  assert.equal(partial.headers.get('content-type'), 'audio/mpeg');
  const suffix = await fetch(audioUrl, { headers: { Range: 'bytes=-32' } });
  assert.equal(suffix.status, 206);
  assert.equal((await suffix.arrayBuffer()).byteLength, 32);
  const invalid = await fetch(audioUrl, { headers: { Range: 'bytes=999999999-' } });
  assert.equal(invalid.status, 416);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/fluffyrhythm/styles.css?v=37`)).status, 200);
  console.log('HTTP verified: every asset, both entry paths, version queries and media seeking.');
} finally {
  child.kill();
}
