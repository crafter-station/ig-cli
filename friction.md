# friction.md

Running notes from building `ig-cli` with the `cli-build` skill. Folded into the case file at the end.

## Phase 0: where the contract comes from

**Mixed.**

- **Defined** (ours): the local model. Niches, creators, videos, metric snapshots, the request budget. Written down in `src/core/types.ts` and `src/db/schema.ts` before any command body.
- **Discovered** (not ours): Instagram's internal web endpoints and the HikerAPI provider. Neither is documented for us. Recon was done first: two research passes over official docs and current repos, then a live capture of the web endpoints, whose responses are the test fixtures.

The official Graph API was ruled out for v1 after reading its docs: no user search, no keyword search, and `media_url` is omitted for most reels since 2026-07-30. It stays planned for v2, where it is the only acceptable way to publish.

## Phase 1: distribution

Audience: JS developers, via npm. So: build to Node with tsup, `#!/usr/bin/env node`, `engines.node >= 22.13`. Bun is the package manager and script runner only.

- The code uses Node's API surface throughout. The one deliberate exception to "anything Node" is `node:sqlite`, which pins the minimum Node version; it removes a native dependency (`better-sqlite3`) that would otherwise need a compiler on install.
- Native binary target not attempted: the CLI is `fetch`- and Playwright-bound.

## Phase 3: blocks

Registry: `@cligentic`, registered in `package.json`, no `components.json` created.

| Block | Decision | Reason |
|---|---|---|
| `detect` | adopt | TTY/JSON mode detection and `shouldColor` in one place |
| `style` | adopt | ANSI-safe width helpers; the table depends on them |
| `banner` | adopt | TTY-only wordmark on bare invoke, on stderr |
| `xdg-paths` | adopt | Per-platform dirs plus the `IG_CLI_HOME` override tests rely on |
| `atomic-write` | adopt | config.json and the halt marker must survive a crash mid-write |
| `json-mode` | reject | Emits arrays as NDJSON and errors as `{ok,error:string}`. Our contract is one envelope `{ok,data,meta}` with `error:{code,message,hint}` for every command |
| `next-steps` | reject | Emits steps as NDJSON on stderr. Ours ride in `meta.nextSteps` so an agent parses one stream. Also depends on `json-mode` |
| `error-map` | reject | `AppError.toJSON()` shape differs from the envelope; and exit codes are derived from the error code here |
| `doctor` | reject | Depends on `json-mode`; checks here also need `required` and `hint` |
| `config` | reject | Profile-oriented loader; this CLI has one zod-validated config with defaults |
| `prompt-secret` | reject | No secret is ever typed: the HikerAPI key comes from the environment, the Instagram login happens in the browser window |
| `trust-ladder`, `audit-log`, `audit-lifecycle`, `killswitch` | reject for v1 | See Phase 4. They come back with publishing in v2 |
| `argv`, `global-flags` | reject | commander handles parsing; global flags are declared per leaf command |

## Phase 4: safety

No v1 command spends money directly, posts anything, or touches a third party's data. The damage that does exist, and what guards it:

| Risk | Guard |
|---|---|
| The logged-in Instagram account gets rate-limited, checkpointed or banned | `Gate`: daily request budget per backend, random pause before each request, and an immediate halt on any block signal with no retry. A halt persists until a human runs `ig auth resume`. The browser backend also refuses to refresh a creator refreshed within `minRefreshDays` |
| Provider credit is burned | Same daily budget, per backend |
| Local data is deleted | `creator remove` without `--niche` and `auth logout` are `writes: "destructive"`: `--dry-run` supported, `--yes` required, never a prompt. Downloaded files are never deleted |

The halt marker is this CLI's killswitch, sized to a read-only tool. It fails closed: an unreadable `halt.json` halts every backend.

## Things that went wrong

- **The bundler rewrote `node:sqlite` to `sqlite`.** tsup's `removeNodeProtocol` defaults to true and `sqlite` has no un-prefixed builtin. Typecheck and unit tests were green; only running `node dist/cli.js` showed it. This is the "test the built artifact" rule paying for itself on the first build.
- **Suppressing the SQLite ExperimentalWarning needs lazy loading.** A static `import "node:sqlite"` is hoisted above the warning filter by the bundler regardless of import order in source. The module is loaded with `createRequire` on first use instead.
- **`--fields` against an open-ended output.** `ig schema` returns a loose object, so validating `--fields` against the declared shape rejected every real key. Field validation falls back to the keys actually present when the output declares none.
- **`bunx --bun shadcn@latest` failed under Git Bash on Windows** with `Script not found "shadcn@latest"` (bun 1.2.0). `npx -y shadcn@latest` worked. The cligentic skill's commands assume bunx.
- **Bun's `.bin` shims are `.exe`/`.bunx` files that `npx` does not find**, so `npx tsc` downloaded a decoy package. Everything runs through `bun run <script>`.

## Recon: what the terrain turned out to be

The research pass said to intercept the web app's `api/v1` endpoints (`web_profile_info`, `clips/user`, `topsearch`). Live, from inside the logged-in page, three of those answered 404. The current web app loads everything through GraphQL, identified by an `x-fb-friendly-name` header, plus JSON embedded in the HTML of a reel page. Two more recon runs mapped which operation carries which field. The backend reads responses by friendly name and never builds a request, so rotating query ids do not break it.

No single surface has everything. The reels tab has play counts but no caption, date or video URL; the timeline and the reel page have those but no play count. The backend joins them, and derives a reel's date from its media id.

About 25 requests were spent on recon and 8 on the end-to-end check, with no rate limit or checkpoint.

## More things that went wrong

- **A collaboration reel would have crashed a refresh.** A reel on one creator's tab can name another account as its user. Stored as-is it references a creator row that does not exist. Found only because a live capture happened to contain one; the doc-derived fixtures of the other backend did not. Fixed in the shared refresh, so it holds for every backend.
- **The harness could not create worktrees for subagents** because the session started before `git init`. Worktrees were created by hand and each agent was told its directory.
- **zod returns the same default object on every parse.** Mutating one Context's config leaked into the next within a process. Harmless in the CLI, wrong in tests. A subagent found it; `loadConfig` now returns a copy.
- **A column where every row said the same thing.** The duration column was a column of dashes on the browser backend, which never learns durations. It is now shown only when some row has one.
- **A group invoked alone printed `(outputHelp)` as its error message** in machine mode. Bare-ish invocations are the case nobody tests.
- **`biome migrate` rewrote `recommended: true` to `preset: "none"`,** silently turning linting off. Caught because a suppression comment was then reported as unused.
