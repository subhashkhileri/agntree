# Harness icons

Session rows use one SVG per harness, theme, and state:

```
<harness>-<theme>-<state>.svg
```

States:

- `working` — the brand mark beats like a heartbeat and carries no badge.
  Motion is the signal: the mark pulses from full size and brightness down to
  78% / 72% and back every 1.4s. A contraction never clips, and the relaxed
  frame is the same size as every other row. Reduced-motion users get the
  mark at rest.
- `done` — the brand mark plus a green dot, meaning the turn finished.
- `closed` — the grey mark, no badge.
- `new` — the brand mark plus a hollow ring for a chat the harness has not
  linked yet.

Themes: `light`, `dark`. The ring behind the done/new badge is painted in the
sidebar background color, so each state has a light and a dark file.

A session is `closed` whenever its terminal is not open. That does not depend
on the stored `status`, which only changes when a close event is observed.

Do not edit the generated files. Edit the base marks in `base/` and run:

```bash
npm run generate:icons
```

Base marks come from [Simple Icons](https://simpleicons.org) (CC0 metadata):
the Claude, OpenCode, and OpenAI marks. A mark gets separate light and dark
files only when the two themes need different fills. Claude Code, OpenAI
Codex, opencode, and their logos are trademarks of their respective owners.
