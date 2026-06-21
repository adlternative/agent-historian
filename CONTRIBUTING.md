# Contributing

Thanks for your interest in agent-historian! This project uses a simple,
standard workflow.

## Development setup

```bash
git clone https://github.com/adlternative/agent-historian.git
cd agent-historian
npm install
npm run build
npm link          # optional: exposes `ochist` globally for testing
```

Requires **Node ≥ 22.5** (for the built-in `node:sqlite` module).

Useful scripts:

```bash
npm run build       # compile TypeScript to dist/
npm run typecheck   # type-check without emitting
npm run clean       # remove dist/
```

## Branch & PR workflow

`main` is protected — **all changes go through a pull request**, no direct
pushes.

1. Branch from `main` with a descriptive name:
   - `feat/<thing>` — new feature
   - `fix/<thing>` — bug fix
   - `docs/<thing>` — docs only
   - `chore/<thing>` — tooling/meta
2. Make your change and keep commits focused. Run `npm run build` and
   `npm run typecheck` before pushing.
3. Open a PR (`gh pr create`) with a clear description of *what* and *why*.
4. After review, squash-merge into `main`.

## Adding support for a new agent

Implement the `HistorySource` interface in `src/sources/<agent>.ts` (see
[`src/sources/types.ts`](src/sources/types.ts)) and register it in
[`src/sources/registry.ts`](src/sources/registry.ts). See the "Add a new agent"
section in the README for the full shape.

Keep sources **read-only** — never write to or mutate an agent's data store.

## Releasing (maintainers)

Releases are automated via GitHub Actions. Just bump the version and push the tag:

```bash
npm version <patch|minor|major>   # bumps package.json + creates a vX.Y.Z tag
git push --follow-tags
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds,
verifies the tag matches `package.json`, runs `npm publish`, and creates a
GitHub Release. No local `npm publish` / OTP needed.

**One-time setup:** add an npm **Automation** access token (bypasses 2FA for CI)
as the GitHub repo secret `NPM_TOKEN`
(npmjs.com → Access Tokens → Generate → Automation; then
`gh secret set NPM_TOKEN`).

Manual fallback:

```bash
npm publish --registry=https://registry.npmjs.org   # requires npm login + 2FA
```

## Code style

- TypeScript, ES modules, `strict` mode on.
- No runtime dependencies — prefer Node built-ins.
- Output stays plain and pipe-friendly; never break stdout piping (handle EPIPE).
- Be mindful of privacy: don't log query text, results, or paths; never make
  network calls.
