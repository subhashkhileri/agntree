/**
 * The website's page registry: every page, its place in the navigation, and the
 * title and description search engines and AI assistants see for it.
 *
 * A Markdown file under docs/ becomes a page only when it is listed here; the
 * build fails on an unlisted file, so the navigation cannot fall behind the
 * docs. Titles and descriptions live together so they can be reviewed side by
 * side: a title stays under 65 characters and a description between 70 and 165,
 * the lengths a search result shows without cutting.
 */

export const site = {
  name: 'Agntree',
  /** Where the site is served, without a trailing slash. A custom domain changes only this. */
  url: 'https://subhashkhileri.github.io/agntree',
  repo: 'https://github.com/subhashkhileri/agntree',
  branch: 'main',
  marketplace: 'https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree',
  extensionId: 'subhashkhileri.agntree',
  author: { name: 'Subhash Khileri', url: 'https://github.com/subhashkhileri' },
  /** One sentence that says what Agntree is; reused by llms.txt and the structured data. */
  summary:
    'Agntree is a free, open-source extension for VS Code and Cursor that manages Claude Code, Codex, opencode, and Pi sessions across git repositories and worktrees: one sidebar to start, resume, fork, find, and review coding-agent sessions.',
  /**
   * Ownership tokens from Google Search Console and Bing Webmaster Tools (the
   * `content` value of the meta tag each one offers). Empty leaves the tag out.
   */
  verification: { google: 'Me8E2Ql5J_olixC37Z48a3DtGjqJ9LE4YMNWi7dWfdA', bing: '' },
  /**
   * The IndexNow key. Not a secret: the build serves it as <key>.txt, where search
   * engines read it to check that a change notice comes from this site. See
   * site/indexnow.mjs.
   */
  indexNowKey: '8958e9546b0eaa97b52be21feae12273',
  socialImage: { path: 'media/og.png', width: 1280, height: 640, alt: 'Agntree: every coding agent session in one VS Code sidebar' },
};

export const landing = {
  title: 'Agntree: Claude Code, Codex, opencode session manager for VS Code',
  description:
    'Free extension for VS Code and Cursor: run Claude Code, Codex, opencode, and Pi in parallel on git worktrees. Resume, fork, and find any session in one sidebar.',
};

export const changelog = {
  source: 'CHANGELOG.md',
  url: 'changelog/',
  nav: 'Changelog',
  title: 'Agntree changelog: every release and what changed',
  description:
    'Release notes for the Agntree VS Code extension: new agents, session features, worktree tools, and fixes in every version.',
};

/** Navigation sections in order. `file` is relative to docs/. */
export const sections = [
  {
    title: 'Start here',
    pages: [
      {
        file: 'README.md',
        nav: 'Overview',
        title: 'Agntree documentation: sessions, worktrees, and agents',
        description:
          'Guides and reference for Agntree, the VS Code session and git worktree manager for Claude Code, Codex, opencode, and Pi.',
      },
      {
        file: 'getting-started.md',
        nav: 'Getting started',
        title: 'Install Agntree and start an agent session in VS Code',
        description:
          'Install Agntree in VS Code or Cursor, add a repository, and start your first Claude Code, Codex, opencode, or Pi session in under two minutes.',
      },
    ],
  },
  {
    title: 'Features',
    pages: [
      {
        file: 'sessions.md',
        nav: 'Sessions',
        title: 'Manage Claude Code, Codex, opencode & Pi sessions in VS Code',
        description:
          'Start, resume, rename, star, import, and clean up coding-agent sessions from the Agntree sidebar, grouped by repository and git worktree.',
      },
      {
        file: 'worktrees.md',
        nav: 'Worktrees and repositories',
        title: 'Git worktrees for coding agents in VS Code',
        description:
          'Create a git worktree per task, check out pull requests, merge, rebase, and delete worktrees from the Agntree sidebar, with each agent session beside its branch.',
      },
      {
        file: 'fork-sessions.md',
        nav: 'Fork a session',
        title: 'Fork a Claude Code, Codex, opencode, or Pi session',
        description:
          'Fork a coding-agent conversation with its full history, in the same worktree or into a new git worktree that carries your uncommitted changes.',
      },
      {
        file: 'find-session.md',
        nav: 'Find Session',
        title: 'Find a past coding-agent session by describing it',
        description:
          'Describe what you worked on and Agntree has an agent search your Claude Code, Codex, opencode, and Pi history in every folder, then resume the match.',
      },
      {
        file: 'notifications.md',
        nav: 'Notifications',
        title: 'Know when a coding agent finishes or needs you',
        description:
          'Agntree shows which agents are working, notifies you when a turn ends or Claude Code asks for permission, and jumps to the session that has waited longest.',
      },
      {
        file: 'agent-panels.md',
        nav: 'Agent panels',
        title: 'Open sessions in the Claude Code and Codex VS Code panels',
        description:
          "Move a session between its terminal and the Claude Code or Codex extension's chat panel, start new sessions in either, and choose the default.",
      },
      {
        file: 'changes-and-files.md',
        nav: 'Changes and files',
        title: 'Review what a coding agent changed in VS Code',
        description:
          'The Changes and All Files panels follow the worktree you select: diff, stage, unstage, and discard agent edits, or browse and edit files in the sidebar.',
      },
    ],
  },
  {
    title: 'Agents',
    pages: [
      {
        file: 'agents/claude-code.md',
        nav: 'Claude Code',
        title: 'Claude Code session manager for VS Code and Cursor',
        description:
          'Use Agntree with Claude Code: resume and fork sessions, run them in parallel on git worktrees, get permission-prompt alerts, and open the Claude Code panel.',
      },
      {
        file: 'agents/codex.md',
        nav: 'Codex',
        title: 'Codex session manager for VS Code and Cursor',
        description:
          'Use Agntree with OpenAI Codex: list, resume, and fork Codex threads per git worktree, get finished-turn alerts, and hand a thread to the Codex panel.',
      },
      {
        file: 'agents/opencode.md',
        nav: 'opencode',
        title: 'opencode session manager for VS Code and Cursor',
        description:
          'Use Agntree with opencode: list, resume, and fork opencode sessions per git worktree through its own CLI and API, with finished-turn notifications.',
      },
      {
        file: 'agents/pi.md',
        nav: 'Pi',
        title: 'Pi coding agent session manager for VS Code and Cursor',
        description:
          'Use Agntree with the Pi coding agent: start, resume, and fork Pi sessions per git worktree, find old ones, and get notified when a turn finishes.',
      },
    ],
  },
  {
    title: 'Guides',
    pages: [
      {
        file: 'guides/parallel-agents-git-worktrees.md',
        nav: 'Run agents in parallel',
        title: 'Run multiple Claude Code agents in parallel with git worktrees',
        description:
          'A step-by-step workflow for running several coding agents at once without conflicts: one git worktree and one session per task, all in one VS Code window.',
      },
      {
        file: 'guides/resume-a-session.md',
        nav: 'Resume a session',
        title: 'How to resume a Claude Code, Codex, opencode, or Pi session',
        description:
          'The CLI command that resumes a session in each coding agent, how to find the session ID, and how to resume any session with one click in VS Code.',
      },
    ],
  },
  {
    title: 'Reference',
    pages: [
      {
        file: 'reference/settings.md',
        nav: 'Settings',
        title: 'Agntree settings reference',
        description:
          'Every Agntree setting with its default: default agent, where sessions open, auto-import and retention, notifications, Find Session, and agent commands.',
      },
      {
        file: 'reference/commands.md',
        nav: 'Commands',
        title: 'Agntree commands and menus reference',
        description:
          'Every Agntree command in the VS Code Command Palette, plus the actions on repository, worktree, session, change, and file rows.',
      },
      {
        file: 'reference/keyboard-shortcuts.md',
        nav: 'Keyboard shortcuts',
        title: 'Agntree keyboard shortcuts',
        description:
          'Default Agntree keyboard shortcuts on Windows, Linux, and macOS: new session, next session that needs you, Find Session, starred sessions, and tree keys.',
      },
    ],
  },
  {
    title: 'More',
    pages: [
      {
        file: 'comparison.md',
        nav: 'Comparison',
        title: 'Agntree compared with Orca, Paseo, and the plain CLI',
        description:
          'How Agntree, a VS Code extension, differs from standalone agent apps such as Orca and Paseo and from running coding-agent CLIs by hand.',
      },
      {
        file: 'faq.md',
        nav: 'FAQ',
        title: 'Agntree FAQ: sessions, worktrees, agents, and privacy',
        description:
          'Answers to common questions about Agntree: supported agents and editors, resuming and forking sessions, git worktrees, pricing, and what leaves your machine.',
      },
      {
        file: 'troubleshooting.md',
        nav: 'Troubleshooting',
        title: 'Troubleshooting Agntree',
        description:
          'Fixes for common Agntree problems: an agent that is not detected, sessions that do not appear, a session that will not resume, and missing notifications.',
      },
      {
        file: 'privacy.md',
        nav: 'Privacy',
        title: 'Agntree privacy: local-first, no telemetry',
        description:
          'Agntree collects no telemetry and keeps its state in VS Code. What it reads, what it stores, and the one feature that sends session text to a model.',
      },
    ],
  },
];
