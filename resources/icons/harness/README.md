# Harness icons

Session rows use one SVG per harness, theme, and state:

```
<harness>-<theme>-<state>.svg
```

States: `default` (no badge), `running` (green), `closed` (pause mark), `new`
(hollow ring). Themes: `light`, `dark`. The ring behind each badge is painted
in the sidebar background color, so each state has a light and a dark file.

Do not edit the generated files. Edit the base marks in `base/` and run:

```bash
npm run generate:icons
```

Base marks come from [Simple Icons](https://simpleicons.org) (CC0 metadata).
The Claude and OpenCode marks are trademarks of their respective owners.
