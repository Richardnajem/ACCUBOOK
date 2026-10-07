import { defineConfig } from "vitest/config";

// The project's tests live in ./tests. Without this config, Vitest's default
// glob also walks leftover probe/vendor trees (e.g. .tmp-symlink-probe) whose
// own test files fail on missing dev-only deps — making `npm test` red even
// when the app's tests all pass.
export default defineConfig({
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
