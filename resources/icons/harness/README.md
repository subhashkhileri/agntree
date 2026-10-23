# Harness icons

Session rows use one SVG per harness, theme, and state:

```
<harness>-<theme>-<state>.svg
```

States: `running` (brand mark plus a green badge), `closed` (grey mark, no
badge), `new` (brand mark plus a hollow ring). Themes: `light`, `dark`. The
ring behind the running/new badge is painted in the sidebar background color,
so each state has a light and a dark file.

A session is `closed` whenever its terminal is not open. That does not depend
on the stored `status`, which only changes when a close event is observed.

Do not edit the generated files. Edit the base marks in `base/` and run:

```bash
npm run generate:icons
```

Base marks come from [Simple Icons](https://simpleicons.org) (CC0 metadata).
The Claude and OpenCode marks are trademarks of their respective owners.
