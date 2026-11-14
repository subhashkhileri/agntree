/**
 * The website and the reference docs are generated from, or describe, files in
 * this repository. These tests keep them from drifting: the site must build
 * (its build fails on a broken link, an unlisted page, or an over-long title),
 * a deploy must tell IndexNow about the pages it changed and no others, and
 * every setting, command, and shortcut the manifest contributes must be
 * documented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import pkg from '../../package.json';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** Run site/indexnow.mjs on a built sitemap and, optionally, the live one it replaces. */
const indexNow = (...sitemaps: string[]) =>
  spawnSync(process.execPath, [path.join(ROOT, 'site', 'indexnow.mjs'), ...sitemaps], { cwd: ROOT, encoding: 'utf8' });

const sections = pkg.contributes.configuration as unknown as { properties: Record<string, unknown> }[];
const commands = pkg.contributes.commands as { command: string; title: string }[];
const keybindings = pkg.contributes.keybindings as { key: string; mac?: string }[];

test('the website builds with every page, link, and machine-readable file in place', (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-site-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [path.join(ROOT, 'site', 'build.mjs'), '--out', out], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  for (const file of [
    'index.html',
    '404.html',
    'docs/index.html',
    'docs/getting-started/index.html',
    'changelog/index.html',
    'sitemap.xml',
    'robots.txt',
    'llms.txt',
    'llms-full.txt',
  ]) {
    assert.ok(fs.existsSync(path.join(out, file)), `${file} is built`);
  }
  const landing = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(landing, /<link rel="canonical" href="https:\/\/[^"]+\/">/);
  assert.match(landing, /"@type":\s*"SoftwareApplication"/);
  assert.doesNotMatch(landing, /\{\{[^}]+\}\}/, 'no placeholder is left unfilled');

  // Every scene the landing page plays has its GIF, and the README shows it on the Marketplace page.
  const scenes = [...landing.matchAll(/data-demo="([a-z]+)"/g)].map((match) => match[1]);
  assert.ok(scenes.length > 1, 'the landing page plays more than one scene');
  const readme = read('README.md');
  assert.deepEqual(scenes.filter((scene) => !fs.existsSync(path.join(out, 'media', `demo-${scene}.gif`)) || !readme.includes(`media/demo-${scene}.gif`)), []);

  // The IndexNow key file is served where a change notice says it is, above every page it vouches for.
  const notice = indexNow(path.join(out, 'sitemap.xml'));
  assert.equal(notice.status, 0, notice.stderr);
  const { key, keyLocation, urlList } = JSON.parse(notice.stdout) as { key: string; keyLocation: string; urlList: string[] };
  const keyDirectory = keyLocation.slice(0, keyLocation.lastIndexOf('/') + 1);
  assert.match(key, /^[A-Za-z0-9-]{8,128}$/);
  assert.equal(fs.readFileSync(path.join(out, keyLocation.slice(keyDirectory.length)), 'utf8'), key);
  assert.ok(urlList.length > 1, 'with no live sitemap, every page is listed');
  assert.deepEqual(urlList.filter((url) => !url.startsWith(keyDirectory)), []);
});

test('the IndexNow request lists only the pages a deploy adds, changes, or removes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-indexnow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sitemap = (name: string, pages: Record<string, string>) => {
    const file = path.join(dir, name);
    const entries = Object.entries(pages).map(([url, modified]) => `<url><loc>https://example.test/${url}</loc><lastmod>${modified}</lastmod></url>`);
    fs.writeFileSync(file, `<urlset>\n${entries.join('\n')}\n</urlset>\n`);
    return file;
  };
  const live = sitemap('live.xml', { '': '2026-01-01', 'kept/': '2026-01-01', 'edited/': '2026-01-01', 'removed/': '2026-01-01' });
  const built = sitemap('built.xml', { '': '2026-01-01', 'kept/': '2026-01-01', 'edited/': '2026-02-01', 'added/': '2026-02-01' });

  const changed = indexNow(built, live);
  assert.equal(changed.status, 0, changed.stderr);
  assert.deepEqual((JSON.parse(changed.stdout) as { urlList: string[] }).urlList.sort(), [
    'https://example.test/added/',
    'https://example.test/edited/',
    'https://example.test/removed/',
  ]);

  const unchanged = indexNow(built, built);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(unchanged.stdout, '', 'nothing is sent when no page changed');

  // An error page saved in place of the live sitemap must not read as "every page is new".
  const errorPage = path.join(dir, 'error.xml');
  fs.writeFileSync(errorPage, '<html>Not found</html>');
  const refused = indexNow(built, errorPage);
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stdout, '');
});

test('the settings reference documents every setting the manifest contributes', () => {
  const doc = read('docs/reference/settings.md');
  const settings = sections.flatMap((section) => Object.keys(section.properties));
  assert.deepEqual(settings.filter((key) => !doc.includes(`\`${key}\``)), []);
});

test('the commands reference names every command the manifest contributes', () => {
  const doc = read('docs/reference/commands.md');
  assert.deepEqual(commands.map((command) => command.title).filter((title) => !doc.includes(title)), []);
});

test('the shortcuts reference lists every default key binding for both platforms', () => {
  const doc = read('docs/reference/keyboard-shortcuts.md');
  const NAMES: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', cmd: 'Cmd', shift: 'Shift', enter: 'Enter', delete: 'Delete', backspace: 'Backspace' };
  const written = (key: string) => key.split('+').map((part) => NAMES[part] ?? part.toUpperCase()).join('+');
  const keys = new Set(keybindings.flatMap((binding) => [binding.key, binding.mac ?? binding.key]).map(written));
  assert.deepEqual([...keys].filter((key) => !doc.includes(`\`${key}\``)), []);
});
