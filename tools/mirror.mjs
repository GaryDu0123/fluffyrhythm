import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public');
const origin = 'https://ubique.city/fluffyrhythm/';
const queue = [origin];
const seen = new Set();
const records = [];
const replacements = new Map();
const assetExtension = /\.(?:html?|css|m?js|json|svg|png|jpe?g|webp|gif|ico|avif|wav|mp3|ogg|m4a|mp4|webm|woff2?|ttf)(?:[?#]|$)/i;

function destination(url) {
  const parsed = new URL(url);
  if (url.startsWith(origin)) {
    const relative = decodeURIComponent(parsed.pathname.slice(new URL(origin).pathname.length));
    return relative || 'index.html';
  }
  if (parsed.hostname.endsWith('dropbox.com')) return 'assets/audio/menu-bgm.wav';
  return `assets/external/${parsed.hostname}/${path.posix.basename(parsed.pathname)}`;
}

function discover(source, currentUrl) {
  // Asset URLs occur in HTML attributes, CSS url(), JS imports and fetch().
  for (const match of source.matchAll(/["'`]([^"'`\r\n]+)["'`]/g)) {
    const candidate = match[1].replaceAll('&amp;', '&').trim();
    if (!assetExtension.test(candidate) || /[{}<>\s]/.test(candidate) || candidate.startsWith('data:')) continue;
    let url;
    try { url = new URL(candidate, currentUrl).href; } catch { continue; }
    if (!/^https?:/.test(url)) continue;
    queue.push(url);
    if (!url.startsWith(origin)) replacements.set(candidate, destination(url));
  }
}

fs.mkdirSync(output, { recursive: true });
for (let i = 0; i < queue.length; i++) {
  const url = queue[i];
  if (seen.has(url)) continue;
  seen.add(url);
  const relative = destination(url);
  const target = path.resolve(output, relative);
  if (!target.startsWith(output + path.sep)) throw new Error(`Unsafe path: ${relative}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.download';
  console.log(`Downloading ${relative}`);
  const result = spawnSync('curl.exe', ['--location', '--fail', '--silent', '--show-error', '--retry', '2', '--connect-timeout', '20', '--max-time', '300', url, '--output', temporary], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Download failed: ${url}\n${result.stderr}`);
  fs.renameSync(temporary, target);
  const data = fs.readFileSync(target);
  records.push({ url, file: `public/${relative.replaceAll('\\', '/')}`, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
  if (/\.(html?|css|m?js|json|svg)$/i.test(relative)) discover(data.toString('utf8'), url);
}

for (const record of records) {
  if (!/\.(html?|css|m?js|json)$/i.test(record.file)) continue;
  const target = path.join(root, record.file);
  let text = fs.readFileSync(target, 'utf8');
  for (const [remote, local] of replacements) {
    let relative = path.relative(path.dirname(target), path.join(output, local)).replaceAll('\\', '/');
    if (!relative.startsWith('.')) relative = './' + relative;
    text = text.replaceAll(remote, relative).replaceAll(remote.replaceAll('&', '&amp;'), relative);
  }
  fs.writeFileSync(target, text);
  record.localSha256 = crypto.createHash('sha256').update(text).digest('hex');
}
fs.writeFileSync(path.join(root, 'mirror-manifest.json'), JSON.stringify({ source: origin, downloadedAt: new Date().toISOString(), files: records }, null, 2) + '\n');
console.log(`Complete: ${records.length} files, ${records.reduce((sum, record) => sum + record.bytes, 0)} bytes.`);
