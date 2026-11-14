/**
 * Takes a picture of a local HTML file with a headless Firefox, which must be
 * installed. Used by the scripts that draw media/: the social card and the
 * demo GIFs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Writes a `width`×`height` PNG of `htmlFile` to `output`. `workDir` holds the throwaway browser profile. */
export function screenshot({ htmlFile, output, width, height, workDir }) {
  const profile = path.join(workDir, 'firefox-profile');
  if (!fs.existsSync(profile)) {
    fs.mkdirSync(profile, { recursive: true });
    // The pictures are always dark, whatever the machine that draws them prefers.
    fs.writeFileSync(
      path.join(profile, 'user.js'),
      'user_pref("ui.systemUsesDarkTheme", 1);\nuser_pref("layout.css.prefers-color-scheme.content-override", 0);\n'
    );
  }
  try {
    execFileSync(
      'firefox',
      ['--headless', '--no-remote', '--profile', profile, `--window-size=${width},${height}`, '--screenshot', output, pathToFileURL(htmlFile).href],
      { stdio: 'ignore', timeout: 120_000 }
    );
  } catch (error) {
    throw new Error(`Could not draw ${path.basename(output)} with Firefox: ${error instanceof Error ? error.message : error}`);
  }
}
