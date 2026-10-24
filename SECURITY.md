# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
| < 1.0   | No        |

## Data Privacy

Agntree operates locally on your machine:

- **No telemetry** — Agntree does not collect or transmit any usage data
- **No network requests from Agntree itself** — Commands you invoke may use the
  network, such as `gh` for PR checkout or `git fetch`, and the coding-agent CLIs
  run as separate tools
- **Session data stays local** — Native sessions remain in the harness's own storage
  (`~/.claude/`, opencode's local store, or `~/.codex/`) on your machine
- **Storage** — Extension state is stored in VS Code's `globalState` (local to your VS Code profile)

The only network activity comes from tools you invoke, including the coding-agent CLIs, which
are separate programs managed by their vendors.

## Reporting a Vulnerability

If you discover a security vulnerability in Agntree, please report it responsibly:

1. **Do not** open a public issue
2. Email the maintainer directly or use [GitHub's private vulnerability reporting](https://github.com/subhashkhileri/agntree/security/advisories/new)
3. Include a description of the vulnerability and steps to reproduce

You should receive a response within 7 days. We will work with you to understand and address the issue before any public disclosure.
