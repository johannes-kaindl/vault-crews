// uebernommen aus obsidian-paperize/scripts/check-pure.mjs, 2026-08-14
//
// `src/core/` und der vendored Kit-Code muessen frei von obsidian-Importen bleiben —
// das ist die Zusicherung, dass die Rechenlogik in Node/vitest testbar ist.
//
// Bewusst ein Script statt eines grep-Einzeilers in package.json: der Einzeiler
// hatte nur `from '…'` mit einfachen Anfuehrungszeichen erfasst und war damit
// blind fuer genau den Fremdcode, den er pruefen soll — das Kit schreibt doppelte.
// Hier gemessen am 2026-08-05 (drift-audit): ein `import { Modal } from "obsidian"`
// in src/vendor/ lief gruen durch.
//
// `src/vendor/kit-obsidian/` ist die bewusst obsidian-gekoppelte Vendor-Schicht und
// deshalb ausgenommen. Die Grenze verlaeuft bei „pure", nicht bei „vendored":
// ein neues gekoppeltes Kit-Modul gehoert in diesen Ordner, nicht in eine weitere
// Ausnahme hier.
//
// EXTRA_FILES sind die beiden ViewModel-Dateien, die zwar unter src/obsidian/ liegen,
// aber per UI-STANDARD §6 pur sein muessen (Render-Schicht getrennt von Rechenlogik).
// Sie standen schon im abgeloesten Einzeiler und behalten hier ihre Abdeckung.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/core", "src/vendor"];
const EXTRA_FILES = [
  "src/obsidian/panel-view-model.ts",
  "src/obsidian/endpoint-editor-model.ts",
];
const EXCLUDED = ["src/vendor/kit-obsidian"];
const FORBIDDEN = /(?:from|import)\s*\(?\s*["']obsidian(\/[^"']*)?["']/;

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (EXCLUDED.includes(full)) return [];
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const offenders = [...ROOTS.flatMap(walk), ...EXTRA_FILES.filter((f) => existsSync(f))]
  .filter((file) => file.endsWith(".ts"))
  .filter((file) => FORBIDDEN.test(readFileSync(file, "utf8")));

if (offenders.length > 0) {
  console.error("obsidian-Import in pure Code gefunden:");
  for (const file of offenders) console.error(`  ${file}`);
  process.exit(1);
}

console.log(`check:pure: ${[...ROOTS, ...EXTRA_FILES].join(" + ")} sind frei von obsidian-Importen`);
