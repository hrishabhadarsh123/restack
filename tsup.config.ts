import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/cli.ts", "src/index.ts", "src/mcp.ts"],
    format: ["esm"],
    target: "node20",
    platform: "node",
    outDir: "dist",
    clean: true,
    sourcemap: true,
    // .d.ts files are emitted by `tsc -p tsconfig.build.json` (see package.json
    // build script): rollup-plugin-dts is still incompatible with TypeScript 7.
    // Keep the provider SDKs external so runtime errors / retries stay intact
    // and the bundles stay lean (tsup externalizes deps by default anyway).
    external: ["@anthropic-ai/sdk", "openai", "@google/genai", "@modelcontextprotocol/sdk"],
    // Note: the shebang lives in src/cli.ts and esbuild preserves it.
  },
]);
