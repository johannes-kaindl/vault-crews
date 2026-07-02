// Regressions-Guard gegen den Smoke-Test-Fund (2026-07-02): Ein natives dynamisches
// `import("node:…")` im gebauten Bundle wird von Obsidians Desktop-Renderer als
// Modul-URL-Fetch behandelt und per CSP/CORS geblockt ("nur chrome/http/https/data") —
// dadurch scheiterte jede git-Operation zur Laufzeit, obwohl alle Tests grün waren.
// Node-Builtins MÜSSEN als statische top-level-Imports geschrieben sein, damit esbuild
// sie im cjs-Bundle zu `require("node:…")` umschreibt (das der Renderer auflöst).
//
// Aufruf: nach dem esbuild-Build (siehe npm-Skript `check:bundle`).
import { readFileSync } from "node:fs";

const BUNDLE = "main.js";
let src;
try {
  src = readFileSync(BUNDLE, "utf8");
} catch {
  console.error(`check:bundle: ${BUNDLE} nicht gefunden — erst bauen (node esbuild.config.mjs --production).`);
  process.exit(1);
}

// Natives dynamisches import() eines node:-Builtins — genau das, was der Renderer blockt.
const offenders = src.match(/import\(\s*["']node:[^"']+["']\s*\)/g);
if (offenders) {
  console.error(
    "check:bundle: FATAL — natives dynamisches import() von node:-Builtin(s) im Bundle.\n" +
      "  Obsidians Renderer blockt das (CSP/CORS). Node-Builtins als STATISCHE top-level-Imports\n" +
      "  schreiben, dann emittiert esbuild require('node:…').\n  Gefunden: " +
      [...new Set(offenders)].join(", "),
  );
  process.exit(1);
}

console.log("check:bundle: ok — kein natives node:-import() im Bundle.");
