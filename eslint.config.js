// @ts-check
/**
 * ESLint flat config (ESLint 9+).
 *
 * Layers:
 *  1. base recommended JS rules (all files)
 *  2. recommended TS rules (all .ts/.tsx)
 *  3. React Hooks + Fast-Refresh rules (renderer only)
 *
 * Run: `npm run lint` (eslint src/)
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import react from "eslint-plugin-react";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      "node-v24*/",
      "*.msi",
      "nul",
    ],
  },

  js.configs.recommended,

  ...tseslint.configs.recommended,

  {
    // Global tweaks over the recommended sets, applied to EVERY file (both
    // main and renderer).
    rules: {
      // The SDK's agent message shapes are untyped → `any` is the pragmatic
      // choice across the codebase. Keep it visible as a warning, not an error.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  {
    files: ["src/renderer/**/*.{ts,tsx}", "src/shared/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The react-hooks v6 rules below are aggressive: mount-time state
      // initialization in effects, render-time ref caching for document-level
      // listeners, and the immutability analysis all flag intentional patterns.
      // Downgraded to warnings so genuine problems stay visible without
      // blocking the build.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      // Components must be the only export of a module (fast-refresh safety).
      // allowConstantExport lets shared constants (e.g. PERMISSION_MODES)
      // coexist with the component in the same file.
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },

  {
    // Main process / preload run under Node.js (or the preload sandbox), not a
    // browser — no React rules apply there.
    files: ["src/main/**/*.ts", "src/preload/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        __dirname: "readonly",
        require: "readonly",
        global: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
      },
    },
  },

  {
    // Vite + Electron config files (node context, CommonJS-style allowed).
    files: ["vite.config.ts", "tsconfig*.json", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        __dirname: "readonly",
      },
    },
    rules: {
      // scripts/ publish helpers intentionally log progress.
      "no-console": "off",
    },
  },
);
