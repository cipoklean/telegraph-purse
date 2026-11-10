// ESLint flat config. Type-aware rules come from typescript-eslint, so lint
// catches real correctness problems (floating promises, misused promises,
// loose equality, unreachable code) that tsc does not look for at all.
//
// tsconfig.json only covers src/, because that is what ships in dist/. Lint also
// reads test/ and scripts/, so it uses tsconfig.eslint.json, which widens the
// include list without changing what the build emits.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  // Generated output, dependencies and local-only artifacts are never linted.
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "demo/**",
      "scripts/demo_recording.js",
      "coverage/**",
      "*.local.mjs",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Correctness rules worth keeping on beyond the recommended set.
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      "no-return-await": "error",
      "no-template-curly-in-string": "error",
      "require-atomic-updates": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],

      // Deliberate: the Telegraph node's response bodies are untyped JSON, and
      // this project parses them at the edge rather than modelling them.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },

  // The wallet-heavy module catches unknown errors and narrows them by hand.
  {
    files: ["src/purse.ts", "src/setup.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },

  // Tests drive handlers with loose object literals on purpose.
  //
  // `no-floating-promises` is off here as a documented false positive: node:test
  // registers the promise returned by test() itself and reports failures through
  // its own runner, so requiring `await test(...)` or `void test(...)` would mean
  // rewriting every test in the file for no behavioural gain. The rule stays on
  // for src/ and scripts/, where a dropped promise really is a bug.
  //
  // `require-atomic-updates` is off for the two tests that swap console.log /
  // console.error to capture output: the reassignment is a deliberate, awaited
  // capture, and the rule cannot see that the restore runs in a finally block.
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "require-atomic-updates": "off",
    },
  },

  // The morning brief is plain ESM JavaScript with JSDoc-free, self-describing
  // shapes; `any` in its tests is the same allowance as above.
  {
    files: ["scripts/*.js"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
