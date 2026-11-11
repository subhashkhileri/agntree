# Contributing to Agntree

Thank you for your interest in contributing to Agntree! This guide covers setup and the PR
process. Before writing code, read [`AGENTS.md`](AGENTS.md): it is the project's working
agreement and explains where a change belongs, what to investigate first, how we test, how
to add support for another coding agent, and what "done" means.

## Getting Started

You need [Node.js](https://nodejs.org/) 20+, [VS Code](https://code.visualstudio.com/)
1.93.0+, and [Git](https://git-scm.com/). A harness CLI ([Claude Code](https://claude.ai/code),
[opencode](https://opencode.ai), [Codex](https://developers.openai.com/codex), or
[Pi](https://pi.dev)) is only needed to try session features by hand; the automated tests
use fakes.

```bash
git clone https://github.com/subhashkhileri/agntree.git
cd agntree
npm install
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host with the extension loaded.
The build, test, and packaging commands are listed in
[`AGENTS.md`](AGENTS.md#build-and-verify); the test suites are described in
[`test/README.md`](test/README.md).

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/subhashkhileri/agntree/issues) to avoid duplicates
2. Use the [bug report template](https://github.com/subhashkhileri/agntree/issues/new?template=bug_report.yml)
3. Include steps to reproduce, expected vs actual behavior, and your environment

### Requesting Features

1. Use the [feature request template](https://github.com/subhashkhileri/agntree/issues/new?template=feature_request.yml)
2. Describe the problem you're trying to solve, not just the solution

### Submitting Pull Requests

1. Fork the repository and create a feature branch from `main`
2. Make the change at the right layer (see [`AGENTS.md`](AGENTS.md#before-writing-code))
3. Meet the [definition of done](AGENTS.md#definition-of-done): typecheck and tests pass,
   UI changes are checked in the Extension Development Host, and `CHANGELOG.md` and the
   affected docs are updated
4. Run the [self-review pass](AGENTS.md#reviewing-your-own-diff) and fix or explain what
   you find; a deliberate smell is explained in the PR description
5. Submit a pull request with a clear description

### Adding support for another coding agent

Agntree models each CLI agent as a **harness**. The questions to answer first, the list of
what ships, and how the existing harnesses solved them are in
[`AGENTS.md`](AGENTS.md#adding-a-harness). If you have questions about the architecture,
[open a discussion](https://github.com/subhashkhileri/agntree/discussions) or [file an
issue](https://github.com/subhashkhileri/agntree/issues).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
