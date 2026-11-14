#!/usr/bin/env node
/**
 * Builds the Agntree website from the Markdown user guide in docs/, the
 * changelog, and the landing page in site/.
 *
 *   npm run build:site             # writes _site/
 *   node site/build.mjs --out dir  # writes somewhere else
 *
 * One source, three readers: the Markdown renders on GitHub as it is, becomes
 * an HTML page here, and is published again as plain Markdown (with llms.txt
 * and llms-full.txt) for AI assistants that read a site without a browser.
 *
 * Every internal URL is relative, so the same output works under
 * /agntree/ on GitHub Pages, at the root of a custom domain, and from a local
 * static server. Only canonical, social, and sitemap URLs use `site.url`.
 *
 * The build fails, naming the file, on a docs page that is not in the
 * registry, a title or description outside its length, and a link or anchor
 * that leads nowhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SCENES, renderWindow, sceneAlt } from './assets/demo.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Marked } from 'marked';
import { site, sections, landing, changelog } from './pages.mjs';

const SITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SITE_DIR);
const TITLE_MAX = 65;
const DESCRIPTION_RANGE = [70, 165];
const HARNESS_ICONS = path.join(ROOT, 'resources', 'icons', 'harness');
const MEDIA_DIR = path.join(ROOT, 'media');
const VIDEO_TYPES = { '.webm': 'video/webm', '.mp4': 'video/mp4' };
const IMAGE_EXTENSIONS = ['.webp', '.png', '.jpg', '.gif'];

// ---------------------------------------------------------------- utilities

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** An HTML partial without the comment at its top, which documents it for whoever edits the file. */
const partial = (file) => read(file).replace(/^\s*<!--[\s\S]*?-->\s*/, '');

const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const stripTags = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** GitHub's heading anchor, so a `#fragment` works on GitHub and on the site. */
function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

/** A relative URL from one site path to another; both are relative to the site root. */
function relativeUrl(from, to) {
  const fromDir = from.endsWith('/') || from === '' ? from : path.posix.dirname(from) + '/';
  const [target, hash = ''] = to.split('#');
  let relative = path.posix.relative(fromDir || '.', target || '.');
  if (target.endsWith('/') || target === '') {
    relative = relative === '' ? './' : `${relative}/`;
  }
  return hash ? `${relative}#${hash}` : relative;
}

/** When a source file last changed, from git; the build time for an uncommitted file. */
function lastModified(file, now) {
  try {
    const date = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return date || now;
  } catch {
    return now;
  }
}

function listMarkdown(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return listMarkdown(path.join(dir, entry.name), relative);
    }
    return entry.name.endsWith('.md') ? [relative] : [];
  });
}

// ------------------------------------------------------------ page registry

/** `docs/agents/pi.md` is served at `docs/agents/pi/`, and `docs/README.md` at `docs/`. */
function pageUrl(file) {
  return file === 'README.md' ? 'docs/' : `docs/${file.replace(/(^|\/)README\.md$/, '$1').replace(/\.md$/, '/')}`;
}

function loadPages() {
  const pages = sections.flatMap((section) =>
    section.pages.map((page) => ({
      ...page,
      section: section.title,
      source: `docs/${page.file}`,
      url: pageUrl(page.file),
      markdownUrl: `docs/${page.file}`,
    }))
  );
  const registered = new Set(pages.map((page) => page.file));
  const unlisted = listMarkdown(path.join(ROOT, 'docs')).filter((file) => !registered.has(file));
  if (unlisted.length > 0) {
    throw new Error(`docs page(s) missing from site/pages.mjs: ${unlisted.join(', ')}`);
  }
  for (const page of [...pages, { ...landing, source: 'landing' }, { ...changelog, source: changelog.source }]) {
    if (page.title.length > TITLE_MAX) {
      throw new Error(`${page.source}: title is ${page.title.length} characters (max ${TITLE_MAX})`);
    }
    const { length } = page.description;
    if (length < DESCRIPTION_RANGE[0] || length > DESCRIPTION_RANGE[1]) {
      throw new Error(`${page.source}: description is ${length} characters (${DESCRIPTION_RANGE.join('–')})`);
    }
  }
  return pages;
}

// ----------------------------------------------------------------- markdown

const CALLOUTS = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };

/**
 * Render one Markdown file. Links are written the way GitHub needs them
 * (relative `.md` paths); `resolveLink` turns each into its site URL.
 */
function renderMarkdown(source, resolveLink) {
  const slug = slugger();
  const headings = [];
  let title = '';

  const marked = new Marked({ gfm: true });
  marked.use({
    walkTokens(token) {
      if (token.type === 'link' || token.type === 'image') {
        token.href = resolveLink(token.href);
      }
    },
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const text = stripTags(html);
        if (depth === 1 && !title) {
          // The layout prints the title, so the page has exactly one <h1>.
          title = text;
          return '';
        }
        const id = slug(text);
        headings.push({ depth, id, text });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${html}</h${depth}>\n`;
      },
      link({ href, title: linkTitle, tokens }) {
        const text = this.parser.parseInline(tokens);
        const external = /^https?:/.test(href) ? ' rel="noopener"' : '';
        const tip = linkTitle ? ` title="${escapeHtml(linkTitle)}"` : '';
        return `<a href="${escapeHtml(href)}"${tip}${external}>${text}</a>`;
      },
      image({ href, text }) {
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy" decoding="async">`;
      },
      blockquote({ tokens }) {
        const body = this.parser.parse(tokens);
        const callout = /^<p>\[!(\w+)\]\s*/.exec(body);
        if (callout && CALLOUTS[callout[1]]) {
          const kind = callout[1].toLowerCase();
          return `<div class="callout ${kind}"><p class="callout-title">${CALLOUTS[callout[1]]}</p><p>${body.slice(callout[0].length)}</div>\n`;
        }
        return `<blockquote>${body}</blockquote>\n`;
      },
    },
  });

  const html = marked
    .parse(source)
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>');
  return { html, headings, title };
}

/**
 * The frequently asked questions as data: every `###` heading in the FAQ is a
 * question and the text up to the next heading is its answer.
 */
function parseFaq(source) {
  const groups = [];
  for (const block of source.split(/^## /m).slice(1)) {
    const [groupTitle, ...rest] = block.split('\n');
    const questions = rest
      .join('\n')
      .split(/^### /m)
      .slice(1)
      .map((entry) => {
        const [question, ...answer] = entry.split('\n');
        return { question: question.trim(), answer: answer.join('\n').trim() };
      });
    groups.push({ title: groupTitle.trim(), questions });
  }
  return groups;
}

// ------------------------------------------------------------------ layouts

const jsonLd = (data) =>
  `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

function head({ title, description, canonical, type, link, extra = '', structured = [] }) {
  const image = `${site.url}/${site.socialImage.path}`;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<meta name="author" content="${escapeHtml(site.author.name)}">
<meta name="theme-color" content="#0b1016">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="${site.name}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="${site.socialImage.width}">
<meta property="og:image:height" content="${site.socialImage.height}">
<meta property="og:image:alt" content="${escapeHtml(site.socialImage.alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${image}">
<link rel="icon" type="image/svg+xml" href="${link('assets/favicon.svg')}">
<link rel="apple-touch-icon" href="${link('assets/icon.png')}">
<link rel="alternate" type="text/plain" title="llms.txt" href="${link('llms.txt')}">
<link rel="stylesheet" href="${link('assets/site.css')}">
${extra}${structured.map(jsonLd).join('\n')}`;
}

function header(link, current) {
  const item = (href, label, key) =>
    `<a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<header class="site-header">
  <div class="wrap">
    <a class="brand" href="${link('')}"><img src="${link('assets/favicon.svg')}" alt="" width="26" height="26">Agntree</a>
    <nav aria-label="Main">
      ${item(link('docs/'), 'Docs', 'docs')}
      ${item(link('#agents'), 'Agents', 'agents')}
      ${item(link(changelog.url), 'Changelog', 'changelog')}
      <a href="${site.repo}" rel="noopener">GitHub</a>
      <a class="button small" href="${site.marketplace}" rel="noopener">Install</a>
    </nav>
  </div>
</header>`;
}

function footer(link, pages) {
  const list = (title, entries) =>
    `<div><h2>${title}</h2><ul>${entries.map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join('')}</ul></div>`;
  const inSection = (title) =>
    pages.filter((page) => page.section === title).map((page) => [link(page.url), page.nav]);
  return `<footer class="site-footer">
  <div class="wrap">
    <div class="footer-grid">
      ${list('Product', [
        [link('docs/getting-started/'), 'Get started'],
        ...inSection('Features').slice(0, 5),
        [link(changelog.url), 'Changelog'],
      ])}
      ${list('Agents', inSection('Agents'))}
      ${list('Learn', [...inSection('Guides'), [link('docs/comparison/'), 'Comparison'], [link('docs/faq/'), 'FAQ'], [link('docs/privacy/'), 'Privacy']])}
      ${list('Project', [
        [site.repo, 'GitHub'],
        [site.marketplace, 'VS Code Marketplace'],
        [`${site.repo}/issues`, 'Issues'],
        [`${site.repo}/blob/${site.branch}/CONTRIBUTING.md`, 'Contributing'],
        [link('llms.txt'), 'llms.txt'],
      ])}
    </div>
    <p class="legal">Agntree is free and open source under the MIT license, built by <a href="${site.author.url}" rel="noopener">${site.author.name}</a>. It is an independent project, not affiliated with or endorsed by Anthropic, OpenAI, the opencode project, or the Pi project. Claude Code, Codex, opencode, Pi, and their logos are trademarks of their respective owners.</p>
  </div>
</footer>`;
}

function document({ headHtml, body, bodyClass = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
${headHtml}
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
<a class="skip" href="#main">Skip to content</a>
${body}
</body>
</html>
`;
}

function docsPage({ page, pages, rendered, modified, structured, link, current = 'docs' }) {
  const index = pages.indexOf(page);
  const previous = index > 0 ? pages[index - 1] : undefined;
  const next = index >= 0 && index < pages.length - 1 ? pages[index + 1] : undefined;
  const nav = sections
    .map(
      (section) => `<div class="nav-group"><p>${section.title}</p><ul>${pages
        .filter((candidate) => candidate.section === section.title)
        .map(
          (candidate) =>
            `<li><a href="${link(candidate.url)}"${candidate === page ? ' aria-current="page"' : ''}>${candidate.nav}</a></li>`
        )
        .join('')}</ul></div>`
    )
    .join('\n');
  const outline = rendered.headings.filter((heading) => heading.depth === 2);
  const toc =
    outline.length > 1
      ? `<aside class="toc" aria-label="On this page"><p>On this page</p><ul>${outline
          .map((heading) => `<li><a href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`)
          .join('')}</ul></aside>`
      : '<aside class="toc"></aside>';
  const crumbs = page.section
    ? `<nav class="crumbs" aria-label="Breadcrumb"><a href="${link('docs/')}">Docs</a><span>›</span>${escapeHtml(page.section)}</nav>`
    : '';
  const pager =
    previous || next
      ? `<nav class="pager" aria-label="Pages">${
          previous ? `<a class="prev" href="${link(previous.url)}"><span>Previous</span>${previous.nav}</a>` : '<span></span>'
        }${next ? `<a class="next" href="${link(next.url)}"><span>Next</span>${next.nav}</a>` : ''}</nav>`
      : '';
  const sourceLinks = page.markdownUrl
    ? `<a href="${link(page.markdownUrl)}">View as Markdown</a> · <a href="${site.repo}/edit/${site.branch}/${page.source}" rel="noopener">Edit this page</a> · `
    : '';

  return document({
    bodyClass: 'docs',
    headHtml: head({
      title: page.title,
      description: page.description,
      canonical: `${site.url}/${page.url}`,
      type: 'article',
      link,
      extra: page.markdownUrl
        ? `<link rel="alternate" type="text/markdown" href="${link(page.markdownUrl)}">\n`
        : '',
      structured,
    }),
    body: `${header(link, current)}
<div class="wrap docs-layout">
  <details class="docs-nav" open>
    <summary>Documentation menu</summary>
    ${nav}
  </details>
  <script>if (matchMedia('(max-width: 860px)').matches) document.currentScript.previousElementSibling.removeAttribute('open');</script>
  <main id="main">
    <article>
      ${crumbs}
      <h1>${escapeHtml(rendered.title)}</h1>
      ${rendered.html}
    </article>
    <p class="page-meta">${sourceLinks}Updated <time datetime="${modified}">${modified.slice(0, 10)}</time></p>
    ${pager}
  </main>
  ${toc}
</div>
${footer(link, pages)}`,
  });
}

// -------------------------------------------------------------------- media

/**
 * A recorded demo, when one exists in media/: a looping, silent video (WebM
 * and/or MP4, with a same-named image as its poster) or a still image. Returns
 * an empty string when nothing was recorded for that name, so a page never
 * shows a broken image.
 */
function mediaTag(name, alt) {
  const has = (extension) => fs.existsSync(path.join(MEDIA_DIR, `${name}${extension}`));
  const image = IMAGE_EXTENSIONS.find(has);
  const videos = Object.keys(VIDEO_TYPES).filter(has);
  if (videos.length > 0) {
    const poster = image ? ` poster="media/${name}${image}"` : '';
    return `<video autoplay muted loop playsinline preload="metadata"${poster} aria-label="${escapeHtml(alt)}">${videos
      .map((extension) => `<source src="media/${name}${extension}" type="${VIDEO_TYPES[extension]}">`)
      .join('')}</video>`;
  }
  return image ? `<img src="media/${name}${image}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">` : '';
}

/**
 * One scene of the illustrated VS Code window. The first frame is in the HTML,
 * so the page is complete without JavaScript; assets/demo.mjs then plays the
 * scene. A phone is too narrow for the window, so it gets the scene's GIF.
 */
function demoHtml(sceneId) {
  const scene = SCENES.find((candidate) => candidate.id === sceneId);
  if (!scene) {
    throw new Error(`site/landing.html: no demo scene named "${sceneId}"`);
  }
  const first = scene.steps[0];
  // Absent only while site/demo-gifs.mjs is drawing it; test/dry/site.test.ts requires every scene's GIF.
  const gif = `media/demo-${scene.id}.gif`;
  const fallback = fs.existsSync(path.join(ROOT, gif))
    ? `\n  <a class="demo-gif" href="${gif}"><img src="${gif}" alt="${escapeHtml(sceneAlt(scene))}" loading="lazy" decoding="async"></a>`
    : '';
  return `<div class="demo" data-demo="${scene.id}">
  <p class="demo-caption" data-demo-caption>${escapeHtml(first.caption)}</p>
  <div class="demo-stage" data-demo-stage>${renderWindow(first)}</div>${fallback}
</div>`;
}

// -------------------------------------------------------------------- build

export function build({ outDir = path.join(ROOT, '_site') } = {}) {
  const now = new Date().toISOString();
  const version = JSON.parse(read('package.json')).version;
  const pages = loadPages();
  const bySource = new Map(pages.map((page) => [page.source, page]));
  const output = new Map();
  const emit = (file, content) => output.set(file, content);

  /** Turn a link written for GitHub into the URL it has from `fromUrl` on the site. */
  const resolver = (sourceFile, fromUrl) => (href) => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) {
      return href;
    }
    const [target, hash] = href.split('#');
    const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), target));
    const suffix = hash ? `#${hash}` : '';
    const page = bySource.get(repoPath);
    if (page) {
      return relativeUrl(fromUrl, page.url) + suffix;
    }
    if (repoPath === changelog.source) {
      return relativeUrl(fromUrl, changelog.url) + suffix;
    }
    if (repoPath.startsWith('media/')) {
      return relativeUrl(fromUrl, repoPath);
    }
    if (repoPath.startsWith('docs/') || repoPath.startsWith('..') || !fs.existsSync(path.join(ROOT, repoPath))) {
      throw new Error(`${sourceFile}: link to "${href}" does not lead to a page or a file in the repository`);
    }
    return `${site.repo}/blob/${site.branch}/${repoPath}${suffix}`;
  };

  const breadcrumbs = (page) => ({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: site.name, item: `${site.url}/` },
      { '@type': 'ListItem', position: 2, name: 'Docs', item: `${site.url}/docs/` },
      ...(page.url === 'docs/' ? [] : [{ '@type': 'ListItem', position: 3, name: page.nav, item: `${site.url}/${page.url}` }]),
    ],
  });
  const article = (page, headline, modified) => ({
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline,
    description: page.description,
    url: `${site.url}/${page.url}`,
    mainEntityOfPage: `${site.url}/${page.url}`,
    dateModified: modified,
    inLanguage: 'en',
    author: { '@type': 'Person', name: site.author.name, url: site.author.url },
    publisher: { '@type': 'Organization', name: site.name, url: `${site.url}/` },
    about: { '@type': 'SoftwareApplication', name: site.name, url: `${site.url}/` },
  });

  // Documentation pages, each also published as the Markdown it was written in.
  const faqSource = read('docs/faq.md');
  const faqGroups = parseFaq(faqSource);
  const inlineMarkdown = new Marked({ gfm: true });
  const plainAnswer = (answer) => stripTags(inlineMarkdown.parse(answer)).replace(/\s+/g, ' ').trim();
  const sitemap = [];
  const fullText = [];

  for (const page of pages) {
    const source = read(page.source);
    const link = (to) => relativeUrl(page.url, to);
    const rendered = renderMarkdown(source, resolver(page.source, page.url));
    const modified = lastModified(page.source, now);
    const structured = [breadcrumbs(page), article(page, rendered.title, modified)];
    if (page.file === 'faq.md') {
      structured.push({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faqGroups.flatMap((group) =>
          group.questions.map(({ question, answer }) => ({
            '@type': 'Question',
            name: question,
            acceptedAnswer: { '@type': 'Answer', text: plainAnswer(answer) },
          }))
        ),
      });
    }
    emit(`${page.url}index.html`, docsPage({ page, pages, rendered, modified, structured, link }));
    // The Markdown copy keeps its relative links to other pages; a link that
    // leaves docs/ would point outside the site, so it becomes absolute.
    const markdown = source.replace(/\]\((\.\.\/[^)\s]+)\)/g, (match, href) => {
      const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(page.source), href));
      const [file, hash] = repoPath.split('#');
      if (file.startsWith('docs/')) {
        return match;
      }
      const absolute = file.startsWith('media/') ? `${site.url}/${file}` : `${site.repo}/blob/${site.branch}/${file}`;
      return `](${absolute}${hash ? `#${hash}` : ''})`;
    });
    emit(page.markdownUrl, markdown);
    fullText.push(`<!-- ${site.url}/${page.url} -->\n\n${markdown.trim()}\n`);
    sitemap.push({ url: page.url, modified });
  }

  // Changelog, from the file releases are cut from.
  {
    const link = (to) => relativeUrl(changelog.url, to);
    const rendered = renderMarkdown(read(changelog.source), resolver(changelog.source, changelog.url));
    const modified = lastModified(changelog.source, now);
    const page = { ...changelog, source: changelog.source };
    emit(
      `${changelog.url}index.html`,
      docsPage({
        page,
        pages,
        rendered,
        modified,
        link,
        current: 'changelog',
        structured: [article(page, rendered.title, modified)],
      })
    );
    sitemap.push({ url: changelog.url, modified });
  }

  // Landing page.
  {
    const link = (to) => relativeUrl('', to);
    const basics = faqGroups[0]?.questions ?? [];
    const faqHtml = basics
      .map(
        ({ question, answer }) =>
          `<details><summary>${escapeHtml(question)}</summary>${renderMarkdown(answer, resolver('docs/faq.md', '')).html}</details>`
      )
      .join('\n');
    const recordedHero = mediaTag('hero', 'Agntree in VS Code: agent sessions grouped by repository and git worktree');
    const body = partial('site/landing.html')
      .replace(/\{\{version\}\}/g, version)
      .replace('{{demo:sessions}}', recordedHero ? `<div class="shot">${recordedHero}</div>` : '{{demo:sessions}}')
      .replace(/\{\{demo:([a-z]+)\}\}/g, (_, sceneId) => demoHtml(sceneId))
      .concat('\n<script type="module" src="assets/demo.mjs"></script>')
      .replace('{{faq}}', faqHtml);
    const leftover = /\{\{[^}]+\}\}/.exec(body);
    if (leftover) {
      throw new Error(`site/landing.html: unknown placeholder ${leftover[0]}`);
    }
    const modified = lastModified('site/landing.html', now);
    emit(
      'index.html',
      document({
        bodyClass: 'landing',
        headHtml: head({
          title: landing.title,
          description: landing.description,
          canonical: `${site.url}/`,
          type: 'website',
          link,
          structured: [
            {
              '@context': 'https://schema.org',
              '@type': 'SoftwareApplication',
              name: site.name,
              description: site.summary,
              url: `${site.url}/`,
              image: `${site.url}/${site.socialImage.path}`,
              applicationCategory: 'DeveloperApplication',
              applicationSubCategory: 'Visual Studio Code extension',
              operatingSystem: 'macOS, Linux, Windows',
              softwareRequirements: 'Visual Studio Code 1.93 or newer, or Cursor',
              softwareVersion: version,
              downloadUrl: site.marketplace,
              installUrl: site.marketplace,
              releaseNotes: `${site.url}/${changelog.url}`,
              license: 'https://opensource.org/licenses/MIT',
              isAccessibleForFree: true,
              offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
              author: { '@type': 'Person', name: site.author.name, url: site.author.url },
              sameAs: [site.repo, site.marketplace],
              dateModified: modified,
            },
            {
              '@context': 'https://schema.org',
              '@type': 'WebSite',
              name: site.name,
              url: `${site.url}/`,
              description: landing.description,
              inLanguage: 'en',
            },
          ],
        }),
        body: `${header(link)}
<main id="main">
${body}
</main>
${footer(link, pages)}
<script src="${link('assets/site.js')}" defer></script>`,
      })
    );
    sitemap.unshift({ url: '', modified });
  }

  // Not found. GitHub Pages serves it at any depth, so its URLs are absolute.
  {
    const link = (to) => `${site.url}/${to}`;
    emit(
      '404.html',
      document({
        bodyClass: 'landing',
        headHtml: head({
          title: 'Page not found | Agntree',
          description: 'This page does not exist. Start from the Agntree documentation or the home page.',
          canonical: `${site.url}/404.html`,
          type: 'website',
          link,
        }).replace('index, follow', 'noindex, follow'),
        body: `${header(link)}
<main id="main"><section class="hero"><div class="wrap narrow">
  <h1>Page not found</h1>
  <p class="lede">That page moved or never existed.</p>
  <p class="actions"><a class="button" href="${link('')}">Home</a><a class="button ghost" href="${link('docs/')}">Documentation</a></p>
</div></section></main>
${footer(link, pages)}`,
      })
    );
  }

  // For crawlers and AI assistants.
  emit(
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemap.map(({ url, modified }) => `  <url><loc>${site.url}/${url}</loc><lastmod>${modified}</lastmod></url>`).join('\n')}
</urlset>
`
  );
  emit(
    'robots.txt',
    `# Agntree is open source and this site is its public documentation.
# Search engines and AI assistants are welcome to index, quote, and learn from it.
User-agent: *
Allow: /

User-agent: GPTBot
User-agent: OAI-SearchBot
User-agent: ChatGPT-User
User-agent: ClaudeBot
User-agent: Claude-SearchBot
User-agent: Claude-User
User-agent: PerplexityBot
User-agent: Perplexity-User
User-agent: Google-Extended
Allow: /

Sitemap: ${site.url}/sitemap.xml
`
  );
  emit(
    'llms.txt',
    `# ${site.name}

> ${site.summary}

- Install: search for "Agntree" in the VS Code Extensions view, or run \`code --install-extension ${site.extensionId}\`.
- Works in VS Code 1.93+ and Cursor, on macOS and Linux; Windows support is partial.
- Supported agents: Claude Code (2.1.310 or newer), OpenAI Codex, opencode (v2), and Pi. Each keeps its own native sessions; Agntree copies nothing into a format of its own.
- Free, MIT licensed, no telemetry. Source: ${site.repo}
- Current version: ${version}

${sections
  .map(
    (section) =>
      `## ${section.title}\n\n${pages
        .filter((page) => page.section === section.title)
        .map((page) => `- [${page.nav}](${site.url}/${page.markdownUrl}): ${page.description}`)
        .join('\n')}`
  )
  .join('\n\n')}

## Optional

- [Full documentation in one file](${site.url}/llms-full.txt): every page above, concatenated
- [Changelog](${site.repo}/blob/${site.branch}/CHANGELOG.md): what changed in each release
- [Architecture](${site.repo}/blob/${site.branch}/ARCHITECTURE.md): how the extension is built
`
  );
  emit(
    'llms-full.txt',
    `# ${site.name} documentation\n\n> ${site.summary}\n\nSource: ${site.url}/ · Version ${version}\n\n${fullText.join('\n---\n\n')}`
  );

  // Write everything, then the files that are copied as they are.
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const [file, content] of output) {
    const target = path.join(outDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  // A stylesheet URL that changes with its content, so a deploy is never served stale.
  const css = fs.readFileSync(path.join(SITE_DIR, 'assets', 'site.css'));
  const cssVersion = createHash('sha256').update(css).digest('hex').slice(0, 8);
  for (const file of output.keys()) {
    if (file.endsWith('.html')) {
      const target = path.join(outDir, file);
      fs.writeFileSync(
        target,
        fs.readFileSync(target, 'utf8').replace(/(assets\/site\.css)"/, `$1?v=${cssVersion}"`)
      );
    }
  }
  fs.cpSync(path.join(SITE_DIR, 'assets'), path.join(outDir, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'resources', 'icons', 'agntree.svg'), path.join(outDir, 'assets', 'favicon.svg'));
  fs.copyFileSync(path.join(ROOT, 'resources', 'icons', 'agntree.png'), path.join(outDir, 'assets', 'icon.png'));
  fs.mkdirSync(path.join(outDir, 'assets', 'harness'), { recursive: true });
  for (const icon of fs.readdirSync(HARNESS_ICONS).filter((name) => name.endsWith('.svg'))) {
    fs.copyFileSync(path.join(HARNESS_ICONS, icon), path.join(outDir, 'assets', 'harness', icon));
  }
  for (const mark of fs.readdirSync(path.join(HARNESS_ICONS, 'base'))) {
    fs.copyFileSync(path.join(HARNESS_ICONS, 'base', mark), path.join(outDir, 'assets', 'harness', `mark-${mark}`));
  }
  if (fs.existsSync(MEDIA_DIR)) {
    fs.cpSync(MEDIA_DIR, path.join(outDir, 'media'), {
      recursive: true,
      // Recordings and images only: the recording guide and the image sources stay in the repository.
      filter: (source) => fs.statSync(source).isDirectory() || /\.(png|jpe?g|gif|webp|webm|mp4)$/.test(source),
    });
  }
  const staticDir = path.join(SITE_DIR, 'static');
  if (fs.existsSync(staticDir)) {
    fs.cpSync(staticDir, outDir, { recursive: true });
  }
  // GitHub Pages must serve the files as built, without running Jekyll over them.
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');

  checkLinks(outDir, [...output.keys()].filter((file) => file.endsWith('.html')));
  return { outDir, pages: output.size };
}

/** Every relative link and fragment in the built pages must lead somewhere. */
function checkLinks(outDir, htmlFiles) {
  const ids = new Map();
  const anchorsOf = (file) => {
    if (!ids.has(file)) {
      const html = fs.readFileSync(path.join(outDir, file), 'utf8');
      ids.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])));
    }
    return ids.get(file);
  };
  const problems = [];
  for (const file of htmlFiles) {
    if (file === '404.html') {
      continue;
    }
    const html = fs.readFileSync(path.join(outDir, file), 'utf8');
    for (const [, raw] of html.matchAll(/\s(?:href|src|poster)="([^"]+)"/g)) {
      const href = raw.replace(/&amp;/g, '&');
      if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) {
        continue;
      }
      const [target, hash] = href.split('#');
      let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target.split('?')[0]));
      if (resolved === '.' || target.endsWith('/') || target === '') {
        resolved = target === '' ? file : path.posix.join(resolved === '.' ? '' : resolved, 'index.html');
      }
      if (resolved.startsWith('..') || !fs.existsSync(path.join(outDir, resolved))) {
        problems.push(`${file}: "${href}" does not exist`);
      } else if (hash && resolved.endsWith('.html') && !anchorsOf(resolved).has(hash)) {
        problems.push(`${file}: "${href}" has no such section`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Broken links in the built site:\n  ${problems.join('\n  ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outFlag = process.argv.indexOf('--out');
  try {
    const result = build(outFlag > 0 ? { outDir: path.resolve(process.argv[outFlag + 1]) } : {});
    console.log(`Built ${result.pages} files in ${path.relative(process.cwd(), result.outDir) || '.'}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
