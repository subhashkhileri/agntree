#!/usr/bin/env node
/**
 * Renders media/og.png, the 1280×640 card that link previews show (Slack, X,
 * LinkedIn, GitHub's social preview) and that tops the README until a demo is
 * recorded.
 *
 *   npm run build:social-card
 *
 * The card reuses the site's stylesheet and the illustrated window in
 * site/assets/demo.mjs, so the three cannot drift apart. It is drawn by a headless
 * Firefox, which must be installed; run it again after changing the tagline,
 * the illustration, or the brand colors, and commit the new image.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';
import { SCENES, renderWindow } from './assets/demo.mjs';
import { screenshot } from './firefox.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WIDTH = 1280;
const HEIGHT = 640;
/** The notification step: agents working, one finished, and the toast that says so. */
const CARD_STEP = { ...SCENES.find((scene) => scene.id === 'notifications').steps[1], cursor: undefined };

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-card-'));
try {
  // A built site gives the card the stylesheet and icons at the paths the illustration expects.
  const siteDir = path.join(work, 'site');
  build({ outDir: siteDir });
  fs.writeFileSync(
    path.join(siteDir, 'card.html'),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="assets/site.css">
<style>
  /* The card is always dark, whatever the machine that renders it prefers. */
  :root {
    --bg: #0a0a0b; --bg-raised: #131315; --border: #26262a; --text: #f4f4f5; --muted: #a1a1aa;
    --accent: #5bb8dc; --green: #3fb950; --shadow: 0 30px 70px -20px rgb(0 0 0 / 80%);
  }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  body {
    display: grid; grid-template-columns: 590px 1fr; gap: 56px; align-items: center; padding: 0 64px;
    background: radial-gradient(52rem 30rem at 85% 0%, rgb(255 255 255 / 7%), transparent 70%), var(--bg);
  }
  .brand { font-size: 30px; gap: 14px; margin-bottom: 34px; }
  .brand img { width: 46px; height: 46px; }
  h1 { margin: 0 0 22px; font-size: 55px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.06; }
  h1 em { font-style: normal; color: var(--muted); }
  p { margin: 0; color: var(--muted); font-size: 25px; line-height: 1.4; }
  p strong { color: var(--text); font-weight: 600; }
  .agents { display: flex; gap: 20px; align-items: center; margin-top: 34px; font-size: 20px; }
  .agents img { width: 30px; height: 30px; }
  /* Only the sidebar fits beside the headline. */
  .vsc { transform: scale(1.14); transform-origin: center right; }
  .vsc-body { grid-template-columns: minmax(0, 1fr); height: 440px; }
  .vsc-activity, .vsc-main { display: none; }
  .vsc * { animation: none !important; }
</style>
</head>
<body>
  <div>
    <div class="brand"><img src="assets/favicon.svg" alt="">Agntree</div>
    <h1>Run every coding agent <em>without leaving VS&nbsp;Code</em>.</h1>
    <p>Sessions and git worktrees for <strong>Claude Code, Codex, opencode, and Pi</strong>.</p>
    <div class="agents">
      <img src="assets/harness/mark-claude.svg" alt="">
      <img src="assets/harness/mark-codex-dark.svg" alt="">
      <img src="assets/harness/mark-opencode-dark.svg" alt="">
      <img src="assets/harness/mark-pi.svg" alt="">
      <span>Free and open source</span>
    </div>
  </div>
  ${renderWindow(CARD_STEP)}
</body>
</html>
`
  );

  const output = path.join(ROOT, 'media', 'og.png');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  screenshot({ htmlFile: path.join(siteDir, 'card.html'), output, width: WIDTH, height: HEIGHT, workDir: work });
  console.log(`Wrote ${path.relative(process.cwd(), output)}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
