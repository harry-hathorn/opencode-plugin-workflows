# Contributing to opencode-plugin-workflows

Thanks for your interest in contributing! This guide covers the basics.

## Development Setup

Requirements:

- **Node.js ≥ 20**
- **npm** (a `package-lock.json` is committed; please use npm)
- **bun** (runs the test suite — `curl -fsSL https://bun.sh/install | bash`)

```bash
git clone https://github.com/harry-hathorn/opencode-plugin-workflows.git
cd opencode-plugin-workflows
npm ci
npm run build
```

To try a local checkout inside opencode, point the plugin config at it:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-plugin-workflows"]
}
```

## Useful Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Bundle to `dist/` (tsup, ESM) |
| `npm run dev` | Rebuild on change |
| `npm test` | Run the bun test suite (hermetic — no LLM, no network) |
| `npm run typecheck` | Type-check `src/` without emitting |
| `npm run lint` | Lint with Biome |
| `npm run format` | Auto-format with Biome |

## Pull Request Workflow

1. **Fork** the repo and create a branch from `main`.
2. **Make your change**, keeping commits focused.
3. **Verify locally** — all of these must pass (CI enforces the same):
   ```bash
   npm run lint
   npm run typecheck
   npm run build
   npm test
   ```
4. **Open a pull request** against `main` and fill in the PR template.
5. **CI must be green** before merge. Address any review feedback.

## Style

- Formatting and linting are enforced by **Biome** (`npm run format`).
- Match the surrounding code's style, naming, and comment density.
- Prefer small, well-scoped commits with clear messages (Conventional Commits
  style is used here, e.g. `feat:`, `fix:`, `docs:`, `chore:`).
- The test suite is deterministic by design — keep it hermetic (no LLM calls,
  no network). Changes to runner semantics should come with journal/sandbox
  coverage.

## Security

Found a security issue? Please report it **privately** — see
[SECURITY.md](./SECURITY.md). Do not open a public issue.

## Code of Conduct

Participation in this project is governed by the
[Code of Conduct](./CODE_OF_CONDUCT.md). Please be excellent to each other.
