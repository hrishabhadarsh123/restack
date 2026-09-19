import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node20",
    platform: "node",
    outDir: "dist",
    clean: true,
    sourcemap: true,
    // Keep the SDK external so runtime errors / retries stay intact and bundle stays lean
    external: ["@anthropic-ai/sdk"],
    // Note: the shebang lives in src/cli.ts and esbuild preserves it.
  },
]);
