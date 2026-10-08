import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The project's tests live in ./tests. Without this config, Vitest's default
// glob also walks leftover probe/vendor trees (e.g. .tmp-symlink-probe) whose
// own test files fail on missing dev-only deps — making `npm test` red even
// when the app's tests all pass.
export default defineConfig({
  resolve: {
    // Route handlers import "@/lib/…". Vitest does not read tsconfig's paths,
    // so without this alias the API-route tests can't load at all.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx,js,mjs}"],
    exclude: [
      "**/node_modules/**",
      "**/.next/**",
      "**/release/**",
      "**/.tmp-symlink-probe/**",
    ],
  },
});
