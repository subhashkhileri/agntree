#!/usr/bin/env node
/**
 * Draws the demo GIFs the README, the Marketplace page, and the phone layout of
 * the landing page show: one short loop per scene, media/demo-<scene id>.gif.
 *
 *   npm run build:demo-gifs
 *
 * Each frame is one step of a scene in site/assets/demo.mjs, the same
 * illustrated window the landing page plays, so the GIFs cannot drift from the
 * site. Frames are drawn by a headless Firefox and joined by Python's Pillow
 * (`python3 -c "import PIL"`); both must be installed. Run it again after
 * changing a scene, and commit the new images.
 *
 * These are illustrations. A real screen recording saved as media/hero.gif is
 * better still; media/README.md says how to make one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';
import { SCENES, renderWindow } from './assets/demo.mjs';
import { screenshot } from './firefox.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WIDTH = 1180;
const HEIGHT = 690;
const STEP_MS = 1900;
/** The last step of a scene stays longer, so the point lands before the next one starts. */
const LAST_STEP_MS = 3000;

const page = (scene, step) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="assets/site.css">
<style>
  :root { --bg: #0a0a0b; --text: #f4f4f5; --muted: #a1a1aa; --border: #26262a; --shadow: none; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  body { padding: 22px 24px 0; text-align: center; }
  .label { display: inline-block; margin-right: 10px; padding: 2px 12px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); font-size: 14px; }
  .caption { margin: 0 0 18px; font-size: 19px; font-weight: 500; }
  .vsc-body { height: 552px; }
  .vsc *, .vsc { animation: none !important; }
</style>
</head>
<body>
  <p class="caption"><span class="label">${scene.label}</span>${step.caption}</p>
  ${renderWindow(step)}
</body>
</html>
`;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-gifs-'));
try {
  // A built site gives the frames the stylesheet and icons at the paths the window expects.
  const siteDir = path.join(work, 'site');
  build({ outDir: siteDir });
  for (const scene of SCENES) {
    const name = `demo-${scene.id}.gif`;
    const frames = scene.steps.map((step, index) => {
      const htmlFile = path.join(siteDir, `frame-${index}.html`);
      const output = path.join(work, `${name}-${index}.png`);
      fs.writeFileSync(htmlFile, page(scene, step));
      screenshot({ htmlFile, output, width: WIDTH, height: HEIGHT, workDir: work });
      return { file: output, ms: index === scene.steps.length - 1 ? LAST_STEP_MS : STEP_MS };
    });
    const output = path.join(ROOT, 'media', name);
    // One palette for every frame keeps colors steady and lets the encoder store only what changed.
    execFileSync(
      'python3',
      [
        '-c',
        `
import json, sys
from PIL import Image
frames = json.loads(sys.argv[1])
images = [Image.open(f["file"]).convert("RGB") for f in frames]
strip = Image.new("RGB", (images[0].width, images[0].height * len(images)))
for i, image in enumerate(images):
    strip.paste(image, (0, image.height * i))
palette = strip.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
quantized = [image.quantize(palette=palette, dither=Image.Dither.NONE) for image in images]
quantized[0].save(sys.argv[2], save_all=True, append_images=quantized[1:], duration=[f["ms"] for f in frames], loop=0, optimize=True, disposal=1)
`,
        JSON.stringify(frames),
        output,
      ],
      { stdio: 'inherit' }
    );
    console.log(`Wrote ${path.relative(process.cwd(), output)} (${frames.length} frames, ${Math.round(fs.statSync(output).size / 1024)} KB)`);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
