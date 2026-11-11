# ig-cli

Instagram creator research from the terminal, built for an AI agent to operate and a human to supervise.

Discover creators by topic, track their reels and metrics over time, find what performed unusually well, and download it.

```
$ ig video top --niche cocina --limit 3
@jamieoliver · 3 reels
#  OUTLIER ↓  PLAYS      AGE  CAPTION                                       LINK
1       8.5x   2.8M  15d ago  German Reibekuchen 🇩🇪 Jamie’s new book 20…  https://www.instagram.com/reel/De_hEKkuZ_x/
2       2.4x   787K  20d ago  –                                             https://www.instagram.com/reel/Dew6XbhNJAw/
3       2.0x   651K  16d ago  –                                             https://www.instagram.com/reel/De9cuVNjSgD/
```

## Use it responsibly

- Reading Instagram with a logged-in session is against Meta's terms. The realistic consequence is losing the account. **Use a secondary account, never one you care about.**
- The CLI is deliberately slow and stops itself at the first sign of pushback. Do not work around that.
- Downloaded videos belong to their creators. Use them as reference, not for reposting.
- It is read-only: it never posts, likes, comments or follows.

## Install

Requires Node 22.13 or newer and Google Chrome.

```bash
git clone https://github.com/crafter-station/ig-cli && cd ig-cli
bun install && bun run build && npm link
ig doctor
```

## First run

```bash
ig auth login browser      # opens Chrome; log in with a secondary account
ig niche create cocina
ig creator search "cocina" --expand --min-followers 10000
ig creator add <usernames> --niche cocina
ig niche refresh cocina
ig video top --niche cocina
ig video download --top 5 --niche cocina
```

Every command prints what to run next.

## How it gets data

| Backend | How | Cost | Risk |
|---|---|---|---|
| `browser` (default) | A real Chrome on a dedicated profile; reads the JSON Instagram's web app loads for itself | Free | The logged-in account |
| `hiker` | [HikerAPI](https://hikerapi.com), set `HIKERAPI_KEY` | About $1 per 1,000 requests | None to an account |

The `hiker` backend is written from the provider's documentation and has not been run against a live key yet. See `test/fixtures/hiker/README.md` for the checklist.

The browser backend's Chrome window is parked off-screen so it does not interrupt you; it still shows in the taskbar while a command runs. `ig config set browserWindow visible` brings it back, which helps when diagnosing a problem. `ig auth login browser` always shows it.

Both pass through the same gate: a daily request budget, a random pause before each request, and an immediate halt on a rate limit or checkpoint. A halt stays until you run `ig auth resume <backend>`.

## Known limits

- Instagram's search returns a handful of accounts per keyword. `--expand`, `--also` and `--hashtags` exist for breadth.
- Play counts exist only for tracked creators after a refresh, not in keyword results.
- On the browser backend a refresh captions about the 12 most recent posts; older reels get a caption when downloaded. Durations are not available.
- A creator refresh costs about 3 requests. With the default budget of 400 a day, a 300-creator niche takes three days of `ig niche refresh --max-creators 120`.

## For agents

```bash
ig schema                 # every command, the envelope, exit codes
ig schema creator.search  # exact input and output JSON Schema of one command
```

Output is a JSON envelope whenever stdout is not a terminal:

```json
{ "ok": true, "data": {}, "meta": { "nextSteps": [] } }
{ "ok": false, "error": { "code": "HALTED", "message": "...", "hint": "..." } }
```

The agent manual is [`skills/ig-cli/SKILL.md`](skills/ig-cli/SKILL.md).

## Storage

`ig config show` prints every path. On Windows: config in `%APPDATA%\ig-cli`, database, media and the Chrome profile in `%LOCALAPPDATA%\ig-cli`. `IG_CLI_HOME=<dir>` relocates all of it; use that for experiments.

## Develop

```bash
bun run build       # dist/cli.js
bun run test
bun run typecheck
bun run format
```

Tests never touch the network. Browser fixtures are trimmed live captures; see `test/fixtures/browser/README.md`. Design notes and what went wrong along the way are in [`friction.md`](friction.md) and [`docs/case.md`](docs/case.md).

## Not built yet

Publishing reels (planned through Meta's official Content Publishing API only), the official Business Discovery API as a third backend, and semantic search over captions and transcripts with embeddings.
