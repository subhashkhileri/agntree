#!/usr/bin/env node
/**
 * Draws resources/icons/agntree.png, the icon the Marketplace and the
 * Extensions view show, from resources/icons/agntree.svg.
 *
 *   npm run build:icon
 *
 * A headless Firefox draws the SVG once on black and once on white, and
 * Python's Pillow recovers the transparent corners from the difference; both
 * must be installed. Run it after editing the SVG, and commit the new image.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { screenshot } from './firefox.mjs';

const ICONS = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'resources', 'icons');
const SIZE = 512;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-icon-'));
try {
  fs.copyFileSync(path.join(ICONS, 'agntree.svg'), path.join(work, 'agntree.svg'));
  const shots = ['#000', '#fff'].map((background, index) => {
    const htmlFile = path.join(work, `icon-${index}.html`);
    const output = path.join(work, `icon-${index}.png`);
    fs.writeFileSync(
      htmlFile,
      `<!doctype html><style>html,body{margin:0;background:${background};overflow:hidden}img{display:block;width:${SIZE}px;height:${SIZE}px}</style><img src="agntree.svg" alt="">`
    );
    screenshot({ htmlFile, output, width: SIZE, height: SIZE, workDir: work });
    return output;
  });
  const output = path.join(ICONS, 'agntree.png');
  execFileSync(
    'python3',
    [
      '-c',
      `
import sys
from PIL import Image, ImageChops
black = Image.open(sys.argv[1]).convert("RGB")
white = Image.open(sys.argv[2]).convert("RGB")
# A pixel that is the same on both backgrounds is opaque; one that follows the background is clear.
alpha = ImageChops.invert(ImageChops.difference(white, black).convert("L"))
pixels = []
for (r, g, b), a in zip(black.getdata(), alpha.getdata()):
    # On black, a pixel shows color x alpha, so divide to get the color back.
    pixels.append((min(255, r * 255 // a), min(255, g * 255 // a), min(255, b * 255 // a), a) if a else (0, 0, 0, 0))
icon = Image.new("RGBA", black.size)
icon.putdata(pixels)
icon.save(sys.argv[3], optimize=True)
`,
      ...shots,
      output,
    ],
    { stdio: 'inherit' }
  );
  console.log(`Wrote ${path.relative(process.cwd(), output)} (${SIZE}×${SIZE}, ${Math.round(fs.statSync(output).size / 1024)} KB)`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
