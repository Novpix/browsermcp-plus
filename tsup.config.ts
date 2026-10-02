import { defineConfig } from "tsup";

export default defineConfig([
  // Package build: dependencies come from node_modules.
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node18",
    platform: "node",
    clean: true,
    sourcemap: true,
  },
  // Release asset: a single file with every dependency bundled, runnable with plain `node`.
  {
    entry: { "browsermcp-plus": "src/index.ts" },
    outDir: "dist/standalone",
    format: ["cjs"],
    outExtension: () => ({ js: ".cjs" }),
    target: "node18",
    platform: "node",
    noExternal: [/.*/],
    minify: true,
    clean: true,
  },
]);
