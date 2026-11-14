#!/usr/bin/env node
/**
 * Writes the IndexNow request for one deploy of the website: the pages whose
 * sitemap entry differs from the sitemap of the site that is live.
 *
 *   node site/indexnow.mjs <built sitemap> [<live sitemap>]
 *
 * IndexNow (https://www.indexnow.org) lets a site tell Bing, Yandex, Naver,
 * Seznam, and Yep that a page was added, changed, or removed, so they fetch it
 * within minutes instead of on their next crawl. Google does not take part.
 * The protocol asks for changed pages only, so "changed" here is what the
 * sitemap already tells crawlers: a new URL, a new `lastmod`, or a URL that is
 * gone. Without a live sitemap every page is listed, which is how the whole
 * site is submitted the first time.
 *
 * Prints the request body as one line of JSON, or nothing when no page
 * changed. The Website workflow sends it after the deploy, once the new pages
 * and the key file are being served. The key is not a secret: engines read it
 * from <site>/<key>.txt, which site/build.mjs writes, to check that the notice
 * comes from the site. A key file below the host's root vouches only for URLs
 * below its own directory, which is every page of the site.
 */
import fs from 'node:fs';
import { site } from './pages.mjs';

/** `loc` → `lastmod` for every page a sitemap lists. */
function pagesOf(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const pages = new Map(
    [...xml.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]*)<\/lastmod>/g)].map((match) => [match[1], match[2]])
  );
  if (pages.size === 0) {
    // An error page saved as the live sitemap must not read as "every page is new".
    throw new Error(`${file} lists no pages`);
  }
  return pages;
}

try {
  const [builtFile, liveFile] = process.argv.slice(2);
  if (!builtFile) {
    throw new Error('Usage: node site/indexnow.mjs <built sitemap> [<live sitemap>]');
  }
  const built = pagesOf(builtFile);
  const live = liveFile ? pagesOf(liveFile) : new Map();
  const urlList = [
    ...[...built].filter(([url, modified]) => live.get(url) !== modified).map(([url]) => url),
    ...[...live.keys()].filter((url) => !built.has(url)),
  ];
  console.error(urlList.length > 0 ? `IndexNow: ${urlList.length} changed\n  ${urlList.join('\n  ')}` : 'IndexNow: no page changed');
  if (urlList.length > 0) {
    console.log(
      JSON.stringify({
        host: new URL(site.url).host,
        key: site.indexNowKey,
        keyLocation: `${site.url}/${site.indexNowKey}.txt`,
        urlList,
      })
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
