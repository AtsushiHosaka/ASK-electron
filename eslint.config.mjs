import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["out", "dist", "dist-electron", "release", "releases", "coverage", "node_modules"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "src/main/**/*.ts",
      "src/preload/**/*.ts",
      "electron.vite.config.ts",
      "scripts/**/*.mjs"
    ],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  {
    files: ["src/renderer/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }]
    }
  }
);
