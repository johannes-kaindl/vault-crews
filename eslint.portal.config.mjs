// Portal-Spiegel (PROF-OBS-08, [SHOULD]): so streng wie der community.obsidian.md-Install-Gate-Scan.
// Wie eslint.config.mjs, aber ohne lokale Abschwaechungen — vor jeder submission-relevanten Aenderung
// `npm run lint:portal` → 0 Probleme.
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  { ignores: ["main.js", "node_modules/", "tests/"] },
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
