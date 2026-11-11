import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // esbuild would rewrite "node:sqlite" to "sqlite", which is not a builtin.
  removeNodeProtocol: false,
  // Playwright is optional at runtime (only the browser backend needs it) and
  // must not be bundled: it locates its own driver relative to its package.
  external: ["playwright", "playwright-core"],
  banner: { js: "#!/usr/bin/env node" },
});
