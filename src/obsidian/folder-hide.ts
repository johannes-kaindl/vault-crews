// uebernommen aus slide-deck/src/folder-hide.ts, 2026-09-25
/** Trim + drop trailing slashes — canonical form for comparison and data-path. */
export function normalizeFolder(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** CSS that hides a folder from Obsidian's file explorer (vault-rag pattern). `data-path` is
 *  internal Obsidian markup (no API) — if it breaks, the folder merely reappears cosmetically
 *  (no data loss). No `:has()` (mobile), `display:none` (explorer virtualisation), value escaped. */
export function buildHideCss(folder: string, hide: boolean): string {
  const p = normalizeFolder(folder);
  if (!hide || p === "") return "";
  const sel = `.nav-folder-title[data-path=${JSON.stringify(p)}]`;
  return `${sel},\n${sel} + .nav-folder-children { display: none; }`;
}
