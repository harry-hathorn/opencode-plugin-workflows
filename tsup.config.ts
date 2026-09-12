import { defineConfig } from "tsup"

// Fully self-contained ESM bundle. @opencode-ai/plugin is imported types-only
// (erased at build), so dist has no runtime dependency on it; acorn/acorn-walk/zod
// are devDependencies and therefore bundled into dist.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "esnext",
  platform: "node",
})
