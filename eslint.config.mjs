import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { readdirSync } from "node:fs";

// Relative imports into a sibling service's internals (e.g. "../quota/time") are forbidden too.
const SERVICES = readdirSync(new URL("./src/server/services", import.meta.url), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const serviceInternals = {
  group: ["@/server/services/*/*", "**/services/*/*"],
  message: "Import services only through their index (`@/server/services/<name>`).",
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-restricted-imports": ["error", { patterns: [serviceInternals] }],
    },
  },
  {
    // Inside a service, relative imports of its own files are fine; cross-service internals are not.
    files: ["src/server/services/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/server/services/*/*", ...SERVICES.map((n) => `../${n}`), ...SERVICES.map((n) => `../${n}/*`)], message: serviceInternals.message },
          ],
        },
      ],
    },
  },
  {
    // Client code must never reach the server layer (keys, DB, Redis).
    files: ["src/components/**", "src/lib/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [serviceInternals, { group: ["@/server/*", "@/server", "@/generated/*"], message: "Client code may not import server modules." }] },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "src/generated/**", "playwright-report/**", "test-results/**", "fixtures/**", "public/**"]),
]);

export default eslintConfig;
