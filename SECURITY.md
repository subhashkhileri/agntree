# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Data Privacy

Agntree operates entirely locally on your machine:

- **No telemetry** — Agntree does not collect or transmit any usage data
- **No network requests** — All operations are local git and file system operations
- **Session data stays local** — Claude Code session files remain in `~/.claude/` on your machine
- **Storage** — Extension state is stored in VS Code's `globalState` (local to your VS Code profile)

The only network activity comes from the Claude Code CLI itself, which is a separate tool managed by Anthropic.

## Reporting a Vulnerability

If you discover a security vulnerability in Agntree, please report it responsibly:

1. **Do not** open a public issue
2. Email the maintainer directly or use [GitHub's private vulnerability reporting](https://github.com/subhashkhileri/agntree/security/advisories/new)
3. Include a description of the vulnerability and steps to reproduce

You should receive a response within 7 days. We will work with you to understand and address the issue before any public disclosure.
