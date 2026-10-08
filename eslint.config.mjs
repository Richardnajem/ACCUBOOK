import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The Electron main process, the preload script and the node scripts/tests
  // that drive them are CommonJS on purpose — require() is the module system
  // there, not a style choice, so the TS-flavoured rule is noise for them.
  {
    files: ["electron/**/*.js", "scripts/**/*.{js,cjs}", "tests/electron/**/*.cjs", "**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Not app source: leftover probe/experiment trees and build + harness
    // output. Linting them drags in vendored packages (and OOMs eslint).
    ".tmp-symlink-probe/**",
    ".smoke/**",
    "backups/**",
    "release/**",
    "tests/electron/update-sim/**",
  ]),
]);

export default eslintConfig;
