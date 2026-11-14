/**
 * The illustrated VS Code window that shows Agntree at work.
 *
 * One description of the window serves three places, so they cannot drift:
 *   - the landing page, which plays one scene per feature (site/build.mjs
 *     renders each first frame into the HTML and this file animates them),
 *   - the README and Marketplace GIFs, one per scene (site/demo-gifs.mjs),
 *   - the social card (site/social-card.mjs).
 *
 * A scene is a short list of steps; a step is the whole state of the window,
 * and renderWindow() turns a state into HTML with no DOM, so it runs in Node
 * and in the browser alike.
 *
 * Keep it true to the extension:
 *   - Rows show what WorkspacesTreeProvider shows: a name, a short time or
 *     "new", a star, and the agent's mark.
 *   - A session opens as a terminal in the editor area (TerminalManager uses
 *     TerminalLocation.Editor), so it is a tab that can be dragged and split.
 *   - A file in the Changes panel opens its diff in the second editor column
 *     (commands/changes.ts), beside the agent.
 *   - Changes and All Files show the worktree of the selected row, and name it
 *     in their titles (extension.ts).
 *   - Menu items and notifications use the extension's own wording.
 *   - Each agent's terminal is drawn after that agent's real interface.
 */

const ICONS = {
  repo: '<svg class="c-dim" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M4 1.5h8.5v10H4a1.5 1.5 0 0 0 0 3h8.5M4 1.5A1.5 1.5 0 0 0 2.5 3v10"/></svg>',
  main: '<svg class="c-amber" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>',
  branch:
    '<svg class="c-dim" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="4.5" cy="3.5" r="1.7"/><circle cx="4.5" cy="12.5" r="1.7"/><circle cx="11.5" cy="5.5" r="1.7"/><path d="M4.5 5.2v5.6M11.5 7.2c0 2.6-7 1.4-7 3.6"/></svg>',
  pr: '<svg class="c-blue" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="4" cy="3.5" r="1.7"/><circle cx="4" cy="12.5" r="1.7"/><circle cx="12" cy="12.5" r="1.7"/><path d="M4 5.2v5.6M12 10.8V6.5A2.5 2.5 0 0 0 9.5 4H7.5m1.8-2L7.5 4l1.8 2"/></svg>',
  staged: '<svg class="c-green" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m3 8.5 3.2 3.2L13 4.8"/></svg>',
  changes: '<svg class="c-amber" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="m10.5 2.5 3 3L6 13l-3.6.6L3 10z"/></svg>',
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 3v10M3 8h10"/></svg>',
  pointer:
    '<svg class="ptr" viewBox="0 0 16 20" aria-hidden="true"><path d="M1.5 1.5v14l3.7-3.4 2.4 5.6 2.3-1-2.4-5.5h5z" fill="#fff" stroke="#000" stroke-width="1.1" stroke-linejoin="round"/></svg>',
  explorer: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M9.5 1.5h-6v13h9v-10zM9.5 1.5v3h3"/></svg>',
  search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><circle cx="7" cy="7" r="4"/><path d="m10 10 4 4"/></svg>',
  scm: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><circle cx="4.5" cy="3.5" r="1.7"/><circle cx="4.5" cy="12.5" r="1.7"/><circle cx="11.5" cy="5.5" r="1.7"/><path d="M4.5 5.2v5.6M11.5 7.2c0 2.6-7 1.4-7 3.6"/></svg>',
  // Agntree's own activity bar icon: resources/icons/agntree-activitybar.svg.
  tree: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.3 19.500 12 4.500l7.700 15"/><rect x="9.400" y="15.500" width="5.200" height="3.400" rx="1.700" fill="currentColor" stroke="none"/></svg>',
  // The codicons VS Code puts on a terminal tab: a sparkle for Claude Code, a terminal for the rest.
  sparkle: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M7 1.5 8.3 6 13 7.5 8.3 9 7 13.5 5.7 9 1 7.5 5.7 6zM12.5 10l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z"/></svg>',
  terminal: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="m4.5 6 2.2 2-2.2 2M8.5 10.5h3"/></svg>',
  file: '<svg class="c-blue" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M9.5 1.5h-6v13h9v-10zM9.5 1.5v3h3"/></svg>',
  diff: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M5 2v8M2.5 6h5M10 13.5h4M3 13.5h5M11 3.5h3"/></svg>',
};

const AGENTS = { claude: 'Claude Code', codex: 'Codex', opencode: 'opencode', pi: 'Pi' };

/**
 * The sessions in the demo, and what each one's terminal shows. A line is
 * [kind, text, detail, result]: `user` is your prompt, `say` the agent's
 * words, `tool` a tool call (its name, what it acted on, what it reported),
 * `work` what it is doing now, `typing` text in the prompt box, and `ask` a
 * permission prompt.
 */
const SESSIONS = {
  coupon: {
    agent: 'claude',
    name: 'Add coupon codes to checkout',
    id: '8c1f2a',
    cwd: '~/code/storefront',
    lines: [
      ['user', 'Add coupon codes to checkout. Percent-off only for now.'],
      ['tool', 'Read', 'src/cart/totals.ts', 'Read 148 lines'],
      ['tool', 'Update', 'src/cart/totals.ts', 'Added 42 lines, removed 6'],
      ['tool', 'Write', 'src/cart/coupon.ts', 'Wrote 58 lines'],
      ['say', 'The discount is applied before tax. Running the cart tests.'],
      ['work', 'Running cart tests…'],
    ],
    // What the same session shows while it waits for permission.
    asking: [
      ['user', 'Add coupon codes to checkout. Percent-off only for now.'],
      ['tool', 'Update', 'src/cart/totals.ts', 'Added 42 lines, removed 6'],
      ['say', 'I need to add a coupons table before the tests can pass.'],
      ['ask', 'Bash command', 'npm run db:migrate -- add-coupons'],
    ],
  },
  flaky: {
    agent: 'codex',
    name: 'Fix flaky cart total test',
    id: '019a7c',
    cwd: '~/code/storefront',
    lines: [
      ['user', 'cart.total.test.ts fails one run in ten. Find out why.'],
      ['tool', 'Explored', 'Read cart.total.test.ts, totals.ts'],
      ['say', 'The test compares floats after summing line items in map order.'],
      ['tool', 'Edited', 'src/cart/totals.ts (+9 -4)'],
      ['tool', 'Ran', 'npm test -- cart --repeat 200', '200 passed'],
      ['say', 'Totals are now summed in integer cents. No failures in 200 runs.'],
    ],
  },
  search: {
    agent: 'opencode',
    name: 'Build typeahead search endpoint',
    id: 'ses_4d',
    cwd: '~/code/storefront-worktrees/feature-search',
    lines: [
      ['user', 'Build GET /api/search?q= with prefix matching, 10 results max.'],
      ['say', "I'll look at how the product routes are set up."],
      ['tool', 'Glob', '"src/api/**/*.ts" (14 matches)'],
      ['tool', 'Read', 'src/api/products.ts'],
      ['tool', 'Write', 'src/api/search.ts'],
      ['tool', 'Write', 'src/api/search.test.ts'],
      ['say', 'Added the route and its tests. p95 is 18 ms on the seed catalog.'],
    ],
  },
  ratelimit: {
    agent: 'pi',
    name: 'Rate limit per API key',
    id: 'b7e0d1',
    cwd: '~/code/api-gateway',
    lines: [
      ['user', 'Rate limit requests per API key: 100 a minute, sliding window.'],
      ['tool', 'read', 'src/middleware/auth.ts'],
      ['tool', '$', 'rg -n "redis" src | head', 'src/cache/client.ts:4:import { createClient } from "redis"'],
      ['tool', 'write', 'src/middleware/rate-limit.ts'],
      ['say', 'Added a sliding-window limiter backed by the existing Redis client.'],
    ],
  },
  tokens: {
    agent: 'claude',
    name: 'Rotate refresh tokens',
    id: '5a3e90',
    cwd: '~/code/api-gateway-worktrees/auth-refresh',
    lines: [['user', 'Rotate refresh tokens on every use.']],
  },
  fresh: {
    agent: 'claude',
    name: 'New Session',
    id: 'e41b09',
    cwd: '~/code/storefront-worktrees/fix-login-redirect',
    welcome: true,
    lines: [['typing', 'After login, send people back to the page they came from']],
  },
  fork: {
    agent: 'claude',
    name: 'Add coupon codes to checkout (1)',
    id: '2d9a77',
    cwd: '~/code/storefront-worktrees/coupon-fixed-amount',
    lines: [
      ['user', 'Add coupon codes to checkout. Percent-off only for now.'],
      ['tool', 'Update', 'src/cart/totals.ts', 'Added 42 lines, removed 6'],
      ['tool', 'Write', 'src/cart/coupon.ts', 'Wrote 58 lines'],
      ['say', 'The discount is applied before tax. Running the cart tests.'],
      ['typing', 'Try fixed-amount coupons instead'],
    ],
  },
};

const DEFAULT_STATUS = { coupon: 'working', flaky: 'done', search: 'working', ratelimit: 'working', tokens: 'closed', fresh: 'new', fork: 'working' };
const DEFAULT_TIME = { coupon: 'now', flaky: '4m', search: '1m', ratelimit: 'now', tokens: '2h', fresh: 'new', fork: 'now' };

/**
 * The worktrees behind the rows, and what the Changes and All Files panels show
 * for each: its title, its staged and unstaged files as [name, directory,
 * status, lines added, lines removed], and the files in src/api.
 */
const COUPON_CHANGES = [
  ['totals.ts', 'src/cart', 'M', 51, 10],
  ['coupon.ts', 'src/cart', 'A', 58, 0],
];
const WORKTREES = {
  main: { title: 'main ~ storefront', staged: [], changes: COUPON_CHANGES, api: ['products.ts'] },
  search: {
    title: 'feature/search ~ storefront',
    staged: [['search.test.ts', 'src/api', 'A', 34, 0]],
    changes: [['search.ts', 'src/api', 'M', 86, 9]],
    api: ['products.ts', 'search.test.ts', 'search.ts'],
  },
  gateway: { title: 'main ~ api-gateway', staged: [], changes: [['rate-limit.ts', 'src/middleware', 'A', 64, 0]], api: ['routes.ts'] },
  refresh: { title: 'auth-refresh ~ api-gateway', staged: [], changes: [], api: ['routes.ts'] },
  // A worktree a scene creates: a new one is clean, and a fork brings the uncommitted changes along.
  fresh: { staged: [], changes: [], api: ['products.ts'] },
  fork: { staged: [], changes: COUPON_CHANGES, api: ['products.ts'] },
};
const WORKTREE_OF = { coupon: 'main', flaky: 'main', search: 'search', ratelimit: 'gateway', tokens: 'refresh', fresh: 'fresh', fork: 'fork' };

const DIFF = [
  ['ctx', 12, 12, 'export async function search(q: string) {'],
  ['del', 13, '', '  return db.products.findMany({'],
  ['del', 14, '', '    where: { name: { contains: q } },'],
  ['del', 15, '', '  });'],
  ['add', '', 13, '  const term = q.trim().toLowerCase();'],
  ['add', '', 14, '  if (term.length < 2) return [];'],
  ['add', '', 15, '  return db.products.findMany({'],
  ['add', '', 16, '    where: { name: { startsWith: term } },'],
  ['add', '', 17, '    take: 10,'],
  ['add', '', 18, '  });'],
  ['ctx', 16, 19, '}'],
];

/**
 * A step. Every field is optional:
 *   caption    one line that says what the step shows
 *   groups     the editor groups, left to right: [{ tabs: [id], active: id }].
 *              A tab is a session id, 'diff', 'file' (search.ts open in an
 *              editor), or 'panel' (the Claude Code panel)
 *   selected   the selected session; Changes and All Files show its worktree
 *   cursor     where the pointer is: a row id, 'toast', 'menu', 'result', 'file'
 *              (the first file under Changes), 'tree-file' (search.ts in All Files)
 *   status     per-session mark overrides (working | done | closed | new)
 *   worktree   an extra worktree under storefront: { name, sessions: [id] }
 *   input      a quick input box: { title, value }
 *   menu       'session' or 'file' to show that row's right-click menu
 *   folded     true to fold the second repository, leaving room for All Files
 *   filesOpen  true when src/api is unfolded in All Files
 *   fileOpen   true when search.ts is open from All Files
 *   toast      a notification's text
 *   find       the Find Session view: { query, searching } or { query, result: sessionId }
 *   drag       a session whose tab is being dragged to the right half
 *   asking     a session that is waiting at a permission prompt
 *   diffOpen   true when the changed file's diff is open
 */
const one = (...tabs) => [{ tabs, active: tabs[tabs.length - 1] }];
const QUERY = 'the one where we fixed the flaky cart test';

export const SCENES = [
  {
    id: 'sessions',
    label: 'Sessions',
    steps: [
      { caption: 'Every agent session, in every repository, in one sidebar.', groups: one('coupon'), selected: 'coupon', cursor: 'flaky' },
      { caption: 'Click a session. It opens as an editor tab, resumed in the agent’s own CLI.', groups: one('coupon', 'flaky'), selected: 'flaky', cursor: 'flaky' },
      { caption: 'Claude Code, Codex, opencode, and Pi. Any repository, same window.', groups: one('coupon', 'flaky'), selected: 'flaky', cursor: 'ratelimit' },
      { caption: 'Claude Code, Codex, opencode, and Pi. Any repository, same window.', groups: one('coupon', 'flaky', 'ratelimit'), selected: 'ratelimit' },
    ],
  },
  {
    id: 'split',
    label: 'Side by side',
    steps: [
      { caption: 'Sessions are ordinary editor tabs. Drag one to the side.', groups: [{ tabs: ['coupon', 'flaky', 'search'], active: 'coupon' }], selected: 'coupon', drag: 'flaky' },
      { caption: 'Watch two agents work side by side.', groups: [{ tabs: ['coupon', 'search'], active: 'coupon' }, { tabs: ['flaky'], active: 'flaky' }], selected: 'flaky' },
      {
        caption: 'Any agents, in any layout VS Code can make.',
        groups: [{ tabs: ['coupon'], active: 'coupon' }, { tabs: ['flaky', 'search'], active: 'search' }],
        selected: 'search',
      },
    ],
  },
  {
    id: 'changes',
    label: 'Changes',
    steps: [
      { caption: 'The Changes panel follows the worktree you select.', groups: one('search'), selected: 'search', cursor: 'file' },
      {
        caption: 'The diff opens beside the agent, so you review while it keeps working.',
        groups: [{ tabs: ['search'], active: 'search' }, { tabs: ['diff'], active: 'diff' }],
        selected: 'search',
        cursor: 'file',
        diffOpen: true,
      },
    ],
  },
  {
    id: 'files',
    label: 'All Files',
    steps: [
      { caption: 'All Files lists the worktree you select, not only the folder VS Code has open.', groups: one('coupon'), selected: 'coupon', folded: true, filesOpen: true, cursor: 'search' },
      { caption: 'Select a session on another branch and the panel follows it.', groups: one('coupon', 'search'), selected: 'search', folded: true, filesOpen: true, cursor: 'tree-file' },
      { caption: 'Open to the side, copy, rename, or delete from the right-click menu.', groups: one('coupon', 'search'), selected: 'search', folded: true, filesOpen: true, menu: 'file', cursor: 'menu' },
      {
        caption: 'Edit a file beside the agent that is working on it.',
        groups: [{ tabs: ['coupon', 'search'], active: 'search' }, { tabs: ['file'], active: 'file' }],
        selected: 'search',
        folded: true,
        filesOpen: true,
        fileOpen: true,
      },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    steps: [
      { caption: 'Keep working while your agents run.', groups: one('flaky'), selected: 'flaky' },
      {
        caption: 'Agntree tells you the moment an agent finishes or needs you.',
        groups: one('flaky'),
        selected: 'flaky',
        asking: 'coupon',
        toast: 'Add coupon codes to checkout needs your input',
        cursor: 'toast',
      },
      { caption: 'Open takes you straight to the agent that is waiting.', groups: one('flaky', 'coupon'), selected: 'coupon', asking: 'coupon' },
    ],
  },
  {
    id: 'worktrees',
    label: 'Worktrees',
    steps: [
      { caption: 'Give each task its own branch and directory.', groups: one('coupon'), selected: 'coupon', cursor: 'repo' },
      {
        caption: 'Create a git worktree without leaving the sidebar.',
        groups: one('coupon'),
        selected: 'coupon',
        input: { title: 'Create Worktree: name the new branch', value: 'fix/login-redirect' },
      },
      { caption: 'Then start an agent in it with one click.', groups: one('coupon'), selected: 'coupon', worktree: { name: 'fix/login-redirect', sessions: [] }, cursor: 'extra' },
      {
        caption: 'Agents in separate worktrees never edit the same files.',
        groups: [{ tabs: ['coupon'], active: 'coupon' }, { tabs: ['fresh'], active: 'fresh' }],
        selected: 'fresh',
        worktree: { name: 'fix/login-redirect', sessions: ['fresh'] },
      },
    ],
  },
  {
    id: 'fork',
    label: 'Fork',
    steps: [
      { caption: 'Want to try a second approach? Fork the session.', groups: one('coupon'), selected: 'coupon', menu: 'session', cursor: 'menu' },
      {
        caption: 'The fork keeps the whole conversation and your uncommitted changes.',
        groups: [{ tabs: ['coupon'], active: 'coupon' }, { tabs: ['fork'], active: 'fork' }],
        selected: 'fork',
        worktree: { name: 'coupon-fixed-amount', sessions: ['fork'] },
      },
    ],
  },
  {
    id: 'find',
    label: 'Find Session',
    steps: [
      { caption: 'Forgot where a conversation went? Describe it.', groups: one('coupon'), selected: 'coupon', input: { title: 'Find Session: describe what you worked on', value: QUERY } },
      { caption: 'An agent searches your history, across every agent and folder.', groups: one('coupon'), selected: 'coupon', find: { query: QUERY, searching: true } },
      { caption: 'Resume the match with one click.', groups: one('coupon'), selected: 'coupon', find: { query: QUERY, result: 'flaky' }, cursor: 'result' },
      { caption: 'Resume the match with one click.', groups: one('coupon', 'flaky'), selected: 'flaky', find: { query: QUERY, result: 'flaky' } },
    ],
  },
  {
    id: 'panel',
    label: 'Agent panels',
    steps: [
      { caption: 'Prefer a chat panel to a terminal?', groups: one('coupon'), selected: 'coupon', cursor: 'coupon' },
      { caption: 'Open the same session in the Claude Code or Codex extension, and back.', groups: one('panel'), selected: 'coupon' },
    ],
  },
];

/** What a scene shows, in one sentence per step: the alt text of its GIF. */
export const sceneAlt = (scene) => `Agntree in VS Code. ${[...new Set(scene.steps.map((step) => step.caption))].join(' ')}`;

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const line = (kind, html) => `<div class="${kind}">${html}</div>`;

/** A terminal drawn after each agent's own interface. */
const TERMINALS = {
  claude(session, lines) {
    const body = lines.map(([kind, text, detail, result]) => {
      switch (kind) {
        case 'user':
          return line('user', `<span class="dim">❯</span> ${escapeHtml(text)}`);
        case 'say':
          return line('say', `<b class="dot">●</b> ${escapeHtml(text)}`);
        case 'tool':
          return line('tool', `<b class="dot ok">●</b> <b>${escapeHtml(text)}</b>(${escapeHtml(detail)})<div class="sub">⎿  ${escapeHtml(result)}</div>`);
        case 'work':
          return line('work', `✻ ${escapeHtml(text)} <span class="dim">(esc to interrupt)</span>`);
        case 'ask':
          return `<div class="askbox"><b>${escapeHtml(text)}</b><div class="cmd">${escapeHtml(detail)}</div><div>Do you want to proceed?</div><div class="pick">❯ 1. Yes</div><div>  2. Yes, and don’t ask again for npm run commands</div><div>  3. No, and tell Claude what to do differently</div></div>`;
        default:
          return '';
      }
    });
    const typing = lines.find(([kind]) => kind === 'typing');
    const welcome = session.welcome
      ? `<div class="welcome"><b class="spark">✻</b> <b>Claude Code</b> <span class="dim">v2.1.325</span><div class="dim">Fable 5.2 with medium effort</div><div class="dim">${escapeHtml(session.cwd)}</div></div>`
      : '';
    const asking = lines.some(([kind]) => kind === 'ask');
    return `${welcome}${body.join('')}${
      asking ? '' : `<div class="promptbox"><span class="dim">❯</span> ${typing ? escapeHtml(typing[1]) : ''}<i class="caret"></i></div><div class="foot dim">? for shortcuts</div>`
    }`;
  },
  codex(session, lines) {
    const body = lines.map(([kind, text, detail, result]) => {
      switch (kind) {
        case 'user':
          return line('band', `<span class="dim">›</span> ${escapeHtml(text)}`);
        case 'say':
          return line('say', `<span class="dim">•</span> ${escapeHtml(text)}`);
        case 'tool':
          return line('tool', `<span class="dim">•</span> <b>${escapeHtml(text)}</b> ${escapeHtml(detail)}${result ? `<div class="sub">└ ${escapeHtml(result)}</div>` : ''}`);
        default:
          return '';
      }
    });
    return `<div class="box"><span class="dim">&gt;_</span> <b>OpenAI Codex</b><div><span class="dim">model:</span>     gpt-6.1-sol medium</div><div><span class="dim">directory:</span> ${escapeHtml(
      session.cwd
    )}</div></div>${body.join('')}<div class="band prompt"><span class="dim">›</span> <i class="caret"></i></div><div class="foot dim">gpt-6.1-sol medium · 62% context left</div>`;
  },
  opencode(session, lines) {
    const body = lines.map(([kind, text, detail]) => {
      switch (kind) {
        case 'user':
          return line('band', escapeHtml(text));
        case 'say':
          return line('say', escapeHtml(text));
        case 'tool':
          return line('tool', `${text === 'Read' ? '→' : '✱'} ${escapeHtml(text)} ${escapeHtml(detail)}`);
        default:
          return '';
      }
    });
    return `<div class="head"><b># ${escapeHtml(session.name)}</b><span class="dim">21,408  11%</span></div>${body.join(
      ''
    )}<div class="say"><span class="accent">▣</span> Build <span class="dim">· big-pickle</span></div><div class="band prompt"><i class="caret"></i><div><span class="accent">Build</span> Big Pickle <span class="dim">OpenCode Zen</span></div></div><div class="foot dim">esc interrupt<span>tab agents   ctrl+p commands</span></div>`;
  },
  pi(session, lines) {
    const body = lines.map(([kind, text, detail, result]) => {
      switch (kind) {
        case 'user':
          return line('band', escapeHtml(text));
        case 'say':
          return line('say', escapeHtml(text));
        case 'tool':
          return line('toolband', `<b>${escapeHtml(text)}</b> <span class="path">${escapeHtml(detail)}</span>${result ? `<div class="dim">${escapeHtml(result)}</div>` : ''}`);
        default:
          return '';
      }
    });
    return `<div class="say"><b class="accent">pi</b><div class="dim">escape interrupt · / commands · ! bash · ctrl+o more</div></div>${body.join(
      ''
    )}<div class="rule"><span>⠹ Working...</span></div><div><i class="caret"></i></div><div class="rule"></div><div class="foot dim">${escapeHtml(
      session.cwd
    )}<span>gemini-4-carbon • high</span></div>`;
  },
};

/** The Claude Code extension's chat panel, showing the same conversation as the coupon session. */
function panelHtml() {
  return `<div class="vsc-panel">
  <div class="msg user">Add coupon codes to checkout. Percent-off only for now.</div>
  <div class="msg"><b class="dot ok">●</b> <b>Read</b> <span class="dim">src/cart/totals.ts</span></div>
  <div class="msg"><b class="dot ok">●</b> <b>Edit</b> <span class="dim">src/cart/totals.ts  +42 −6</span></div>
  <div class="msg"><b class="dot ok">●</b> <b>Write</b> <span class="dim">src/cart/coupon.ts  +58</span></div>
  <div class="msg">The discount is applied before tax. Running the cart tests.</div>
  <div class="msg work">✻ Running cart tests…</div>
  <div class="composer"><span class="dim">Queue another message…</span><div><span class="chip">Ask before edits</span><span class="chip">totals.ts</span><b class="send">↑</b></div></div>
</div>`;
}

/** search.ts as it is after the change in DIFF, open in an ordinary editor. */
function fileHtml() {
  return `<div class="vsc-diff">${DIFF.filter(([kind]) => kind !== 'del')
    .map(([, , after, text]) => `<div><span class="no">${after}</span><span class="sign"> </span>${escapeHtml(text)}</div>`)
    .join('')}</div>`;
}

function diffHtml() {
  return `<div class="vsc-diff">${DIFF.map(
    ([kind, before, after, text]) =>
      `<div class="${kind}"><span class="no">${before}</span><span class="no">${after}</span><span class="sign">${kind === 'add' ? '+' : kind === 'del' ? '-' : ' '}</span>${escapeHtml(text)}</div>`
  ).join('')}</div>`;
}

/** The whole window for one step, as HTML. `assets` is the URL prefix of the site's assets folder. */
export function renderWindow(step = SCENES[0].steps[0], { assets = 'assets/' } = {}) {
  const status = { ...DEFAULT_STATUS, ...step.status };
  const pointer = (where) => (step.cursor === where ? ICONS.pointer : '');
  const mark = (id) => {
    const { agent } = SESSIONS[id];
    return `<img src="${assets}harness/${agent}-dark-${status[id]}.svg" alt="${AGENTS[agent]}, ${status[id]}">`;
  };
  const row = ({ id, level = 0, twist, icon = '', name, desc = '', action = false }) => {
    const classes = [`l${level}`, step.selected === id && 'selected', step.cursor === id && 'hover'].filter(Boolean).join(' ');
    const right = action && step.cursor === id ? `<span class="act">${ICONS.plus}</span>` : desc ? `<span class="desc">${desc}</span>` : '';
    return `<li class="${classes}">${twist ? `<span class="twist">${twist}</span>` : ''}${icon}<span class="name">${escapeHtml(name)}</span>${right}${pointer(id)}</li>`;
  };
  const session = (id, desc) => row({ id, level: 2, icon: mark(id), name: SESSIONS[id].name, desc: desc ?? DEFAULT_TIME[id] });

  const rows = [
    row({ id: 'repo', twist: '▾', icon: ICONS.repo, name: 'storefront', action: true }),
    row({ id: 'wt-main', level: 1, twist: '▾', icon: ICONS.main, name: 'main', desc: '●' }),
    session('coupon'),
    session('flaky', `<span class="star">★</span> ${DEFAULT_TIME.flaky}`),
    row({ id: 'wt-search', level: 1, twist: '▾', icon: ICONS.branch, name: 'feature/search', desc: '↑2 · PR #184' }),
    session('search'),
  ];
  if (step.worktree) {
    rows.push(row({ id: 'extra', level: 1, twist: '▾', icon: ICONS.branch, name: step.worktree.name, action: true }));
    rows.push(...step.worktree.sessions.map((id) => session(id)));
  }
  rows.push(row({ id: 'repo2', twist: step.folded ? '▸' : '▾', icon: ICONS.repo, name: 'api-gateway' }));
  if (!step.folded) {
    rows.push(
      row({ id: 'wt2-main', level: 1, twist: '▾', icon: ICONS.main, name: 'main' }),
      session('ratelimit'),
      row({ id: 'wt2-pr', level: 1, twist: '▾', icon: ICONS.pr, name: 'auth-refresh', desc: 'PR #88' }),
      session('tokens')
    );
  }

  // Changes and All Files follow the selected row's worktree.
  const worktree = WORKTREES[WORKTREE_OF[step.selected]] ?? WORKTREES.main;
  const title = `<small>(${escapeHtml(worktree.title ?? `${step.worktree?.name} ~ storefront`)})</small>`;
  const counts = (added, removed) => `<span class="add">+${added}</span>${removed ? ` <span class="del">-${removed}</span>` : ''}`;
  const section = (name, icon, files, pointed) =>
    files.length
      ? `<li><span class="twist">▾</span>${icon}<span class="name">${name}</span><span class="desc">${files.length} file${files.length === 1 ? '' : 's'} · ${counts(
          files.reduce((sum, file) => sum + file[3], 0),
          files.reduce((sum, file) => sum + file[4], 0)
        )}</span></li>${files
          .map(([name, directory, letter, added, removed], index) => {
            const on = pointed && index === 0;
            return `<li class="l1${on && step.cursor === 'file' ? ' hover' : ''}${on && step.diffOpen ? ' selected' : ''}">${ICONS.file}<span class="name">${name}</span><span class="desc">${directory} · ${letter} ${counts(
              added,
              removed
            )}</span>${on ? pointer('file') : ''}</li>`;
          })
          .join('')}`
      : '';
  const changes =
    section('Staged Changes', ICONS.staged, worktree.staged, false) + section('Changes', ICONS.changes, worktree.changes, true) ||
    `<li class="dim">${ICONS.staged}<span class="name">No uncommitted changes</span></li>`;

  // Folders first, then files, as FilesTreeProvider sorts them.
  const folder = (name, level, open) => `<li class="l${level}"><span class="twist">${open ? '▾' : '▸'}</span><span class="name">${name}</span></li>`;
  const file = (name, level) => {
    const pointed = name === 'search.ts';
    return `<li class="l${level} f${pointed && (step.cursor === 'tree-file' || step.menu === 'file') ? ' hover' : ''}${pointed && step.fileOpen ? ' selected' : ''}">${
      ICONS.file
    }<span class="name">${name}</span>${pointed ? pointer('tree-file') : ''}</li>`;
  };
  const files = [
    folder('src', 0, step.filesOpen),
    ...(step.filesOpen ? [folder('api', 1, true), ...worktree.api.map((name) => file(name, 2)), folder('cart', 1, false)] : []),
    folder('test', 0, false),
    file('package.json', 0),
    file('README.md', 0),
  ].join('');

  const find = step.find
    ? `<ul><li><span class="twist">▾</span><span class="name">${escapeHtml(step.find.query)}</span><span class="desc">${
        step.find.searching ? 'searching…' : '1 session · now'
      }</span></li>${
        step.find.searching
          ? '<li class="l1 dim"><span class="spin"></span><span class="name">Reading Codex sessions in ~/code/storefront</span></li>'
          : `<li class="l1${step.cursor === 'result' ? ' hover' : ''}">${mark(step.find.result)}<span class="name">${escapeHtml(
              SESSIONS[step.find.result].name
            )}</span><span class="desc">storefront · 3d</span>${pointer('result')}</li>`
      }</ul>`
    : '';

  const tab = (id, active) => {
    const cls = `tab${active ? ' on' : ''}`;
    if (id === 'diff') {
      return `<span class="${cls}">${ICONS.diff}<span>search.ts (Working Tree)</span></span>`;
    }
    if (id === 'file') {
      return `<span class="${cls}">${ICONS.file}<span>search.ts</span></span>`;
    }
    if (id === 'panel') {
      return `<span class="${cls}"><img src="${assets}harness/mark-claude.svg" alt=""><span>Add coupon codes to checkout</span></span>`;
    }
    const { agent, name, id: shortId } = SESSIONS[id];
    return `<span class="${cls}">${agent === 'claude' ? ICONS.sparkle : ICONS.terminal}<span>Agntree: ${escapeHtml(name)} [${shortId}]</span></span>`;
  };
  const content = (id) => {
    if (id === 'diff') {
      return diffHtml();
    }
    if (id === 'file') {
      return fileHtml();
    }
    if (id === 'panel') {
      return panelHtml();
    }
    const current = SESSIONS[id];
    const lines = step.asking === id && current.asking ? current.asking : current.lines;
    return `<div class="vsc-term t-${current.agent}">${TERMINALS[current.agent](current, lines)}</div>`;
  };
  const groups = (step.groups ?? [])
    .map(({ tabs, active }) => `<div class="vsc-group"><div class="vsc-tabs">${tabs.map((id) => tab(id, id === active)).join('')}</div>${content(active)}</div>`)
    .join('');

  return `<div class="vsc" role="img" aria-label="A VS Code window with the Agntree sidebar: two repositories with their git worktrees, and Claude Code, Codex, opencode, and Pi sessions under each branch. Sessions are open as editor tabs beside the code, and the Changes and All Files panels show the selected worktree.">
  <div class="vsc-title"><i></i><i></i><i></i><span>storefront — Visual Studio Code</span></div>
  <div class="vsc-body">
    <div class="vsc-activity"><span>${ICONS.explorer}</span><span>${ICONS.search}</span><span>${ICONS.scm}</span><span class="on">${ICONS.tree}</span></div>
    <div class="vsc-side">
      <div class="vsc-view">Workspaces</div>
      <ul>${rows.join('')}</ul>
      <div class="vsc-view${step.find ? '' : ' closed'}">Find Session</div>
      ${find}
      <div class="vsc-view">Changes ${title}</div>
      <ul>${changes}</ul>
      <div class="vsc-view">All Files ${title}</div>
      <ul>${files}</ul>
    </div>
    <div class="vsc-main" style="--groups:${Math.max(1, (step.groups ?? []).length)}">${groups}${
      step.drag ? `<div class="vsc-drop"></div><div class="vsc-ghost">${tab(step.drag, true)}${ICONS.pointer}</div>` : ''
    }</div>
    ${step.input ? `<div class="vsc-input"><small>${escapeHtml(step.input.title)}</small><div>${escapeHtml(step.input.value)}<b></b></div></div>` : ''}
    ${step.menu ? contextMenu(step.menu, pointer('menu')) : ''}
    ${step.toast ? `<div class="vsc-toast"><span>${escapeHtml(step.toast)}</span><b>Open${pointer('toast')}</b></div>` : ''}
  </div>
</div>`;
}

/** The right-click menu of a session row or of a file in All Files, with the item the step is about marked `*`. */
const MENUS = {
  session: ['Open Session in Terminal', 'Open in Claude Code UI', 'Rename Session…', 'Star Session', '-', 'Fork Session Here', '*Fork Session to New Worktree…', '-', 'Copy Resume Command'],
  file: ['*Open to the Side', '-', 'Reveal in File Manager', 'Open in Integrated Terminal', '-', 'Copy Path', 'Copy Relative Path', '-', 'Copy', 'Cut', '-', 'Rename…', 'Delete'],
};

function contextMenu(kind, pointer) {
  return `<span class="vsc-menu of-${kind}">${MENUS[kind]
    .map((item) =>
      item === '-' ? '<hr>' : item.startsWith('*') ? `<span class="on">${escapeHtml(item.slice(1))}${pointer}</span>` : `<span>${escapeHtml(item)}</span>`
    )
    .join('')}</span>`;
}

/**
 * Plays one scene inside a `[data-demo="<scene id>"]` element built by
 * site/build.mjs, looping its steps while it is on screen. The last step stays
 * twice as long, so the point lands before the loop starts again. With reduced
 * motion it shows the last step and never advances.
 */
export function play(root, { assets = 'assets/', stepMs = 2100 } = {}) {
  const scene = SCENES.find((candidate) => candidate.id === root.dataset.demo);
  const stage = root.querySelector('[data-demo-stage]');
  const caption = root.querySelector('[data-demo-caption]');
  if (!scene || !stage) {
    return;
  }
  const last = scene.steps.length - 1;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let step = still ? last : 0;
  let held = false;
  let visible = false;

  const show = () => {
    stage.innerHTML = renderWindow(scene.steps[step], { assets });
    caption.textContent = scene.steps[step].caption;
  };
  show();
  if (still) {
    return;
  }
  // The stage is hidden on a phone, where the scene's GIF is shown instead, so it never plays there.
  new IntersectionObserver(([entry]) => (visible = entry.isIntersecting)).observe(stage);
  setInterval(() => {
    if (!visible || document.hidden) {
      return;
    }
    if (step === last && !held) {
      held = true;
      return;
    }
    held = false;
    step = step === last ? 0 : step + 1;
    show();
  }, stepMs);
}

if (typeof document !== 'undefined') {
  for (const root of document.querySelectorAll('[data-demo]')) {
    play(root);
  }
}
