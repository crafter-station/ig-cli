# ig-cli

Instagram creator research from the terminal, built for an AI agent to operate and a human to supervise.

Discover creators by topic, track their reels and metrics over time, find what performed unusually well, and download it.

> **Status: under construction.** The command contracts are defined; backends and command bodies are landing.

## Use it responsibly

- Reading Instagram with a logged-in session is against Meta's terms. The realistic consequence is losing the account. **Use a secondary account, never one you care about.**
- The CLI is deliberately slow and stops itself at the first sign of pushback. Do not work around that.
- Downloaded videos belong to their creators. Use them as reference, not for reposting.

## Develop

```bash
bun install
bun run build       # dist/cli.js, runs on Node >= 22.13
bun run test
bun run typecheck
bun run format
```

`IG_CLI_HOME=<dir>` relocates config, database, browser profile and media. Use it for any experiment.

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
