/**
 * The website and the reference docs are generated from, or describe, files in
 * this repository. These tests keep them from drifting: the site must build
 * (its build fails on a broken link, an unlisted page, or an over-long title),
 * and every setting, command, and shortcut the manifest contributes must be
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
