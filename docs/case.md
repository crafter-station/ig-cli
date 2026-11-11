---
cli: ig-cli
target: a social network's logged-in web app, plus a paid data API for the same data; owns a local SQLite model of creators, videos and metric history
origin: mixed
built: 2026-11-11
status: internal
distribution: npm (built to Node, linked locally; not yet published)
---

# ig-cli

Case file in the format of the `cli-build` skill (`cases/README.md`). `friction.md` holds the running notes this was folded from.

## What it does

Discovers creators and short videos by topic, tracks creators in named niches, snapshots follower and video metrics on each refresh, ranks videos by how far they beat their creator's own median, and downloads them. Read-only.

## Contract origin

Mixed, and classified that way before any code.

- **Defined:** niches, creators, videos, snapshots, request budget. `src/core/types.ts` (zod) and `src/db/schema.ts` were written first; every command's input and output schema was written as a stub before its body (`src/commands/*.ts`), and three agents then filled bodies in parallel without changing one schema.
- **Discovered:** the web app. The desk research was wrong about the terrain: it named REST-style endpoints, and three of them answered 404 from inside the logged-in page. Three short live recon runs found that the app loads data through named GraphQL operations and HTML-embedded JSON. The backend reads those responses by operation name and never constructs a request.
- **What the defined half had wrong:** the `Video` entity assumed one surface would supply all fields. None does. Play counts, captions and video URLs come from three different pages, so `caption`, `durationSec` and `videoUrl` are often null after a refresh. The schema allowed null everywhere, which is the only reason it survived.

## Distribution choice

Build to Node with tsup, `#!/usr/bin/env node`, `engines.node >= 22.13`. The audience is JS developers. Bun is the package manager and script runner only. `node:sqlite` sets the Node floor and removes a native dependency. Native binary was not attempted: the CLI depends on `fetch` and on a browser automation library.

## Blocks adopted

From `@cligentic`, registered in `package.json`, no `components.json` created.

- **Adopted:** `detect`, `style`, `banner`, `xdg-paths`, `atomic-write`.
- **Rejected:** `json-mode`, `next-steps`, `error-map`, `doctor` (their output shapes conflict with this CLI's single envelope, and the last three depend on the first); `config` (profile-oriented; this CLI has one zod-validated config); `prompt-secret` (no secret is ever typed); `trust-ladder`, `audit-log`, `audit-lifecycle`, `killswitch` (nothing in v1 spends money or writes to a third party; see below); `argv`, `global-flags` (commander).

Safety was sized to the damage: the thing at risk is a logged-in account. One `Gate` (`src/core/gate.ts`) holds a daily budget per backend, a random pause before each request, and a halt marker written on any block signal, with no retry and no automatic resume. Call sites, by grep: `gate.before()` in `src/backends/browser/session.ts` (3) and `src/backends/hiker/client.ts` (2); `gate.block(` in the same two files (3 and 1). Two commands delete local data; both require `--yes`, support `--dry-run`, and never prompt.

## What broke

- The bundler rewrote `node:sqlite` to `sqlite`. Typecheck and unit tests were green; running `node dist/cli.js` was not.
- Suppressing the SQLite experimental warning needed lazy loading, because the bundler hoists a static import above the filter.
- `--fields` rejected every key of an open-ended output.
- A collaboration video named a different account as its user and would have violated a foreign key on refresh. Only a live capture contained one.
- zod's shared default object leaked config between contexts in one process.
- A group invoked without a subcommand reported `(outputHelp)` as its error in machine mode.
- A lint config migration silently disabled linting.
- The human table had a column in which every row was a dash.

## What I would do differently

- Run the live recon before writing the entity schema, not after. Ten minutes of capture would have shown that fields are split across surfaces.
- Not trust desk research about an undocumented target for anything more specific than "it exists". It was right about tools and wrong about endpoints.
- Have the paid-API backend verified against a live key before merging. It is built from the provider's documents, 65 tests pass against document-derived fixtures, and none of that is evidence about the live API. The collaboration bug is exactly the kind of thing such fixtures cannot contain.
- Decide caption coverage up front. Roughly half of a creator's refreshed reels arrive without a caption on the browser backend, which weakens the local text search.

## Evidence

- Repo: `crafter-station/ig-cli` (private). Entry `src/cli.ts`, commands in `src/commands/`, backends in `src/backends/{browser,hiker}/`, store in `src/db/store.ts`.
- 312 tests in 13 files. Browser fixtures are trimmed live captures (`test/fixtures/browser/`); the paid-API fixtures are document-derived and say so (`test/fixtures/hiker/README.md`).
- Observed live with the linked binary: `creator search` (2 requests), `creator add` (1), `niche refresh` of one creator with 14 reels (3), `video top`, `video download` of one 13 MB mp4 (1), `video discover` (1). No block signals.
- Not observed: the paid-API backend against a live key; `creator search --expand`; a refresh interrupted by a real block; `auth login` driven through the CLI itself (the session was created by a recon script and its marker written by hand); a real terminal (human output was read through `NO_JSON=1` over a pipe).
- Halt marker: `<state>/halt.json`. There is no audit log; no v1 command warrants one.
