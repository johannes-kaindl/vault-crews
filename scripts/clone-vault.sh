#!/usr/bin/env bash
# scripts/clone-vault.sh
#
# Erzeugt einen WEGWERF-KLON eines Obsidian-Vaults für die manuelle Release-
# Smoke-Checkliste (Spec §8: "Kein Live-LLM in CI; manuelle Smoke-Checkliste
# gegen einen Wegwerf-Klon des Pallas-Vaults ... nie der echte Vault").
#
# ══════════════════════════════════════════════════════════════════════════
#  NIEMALS den echten Vault (SOURCE_VAULT) selbst für die Smoke-Checkliste
#  öffnen oder verändern. Dieses Skript LIEST ihn nur (rsync, keine
#  Löschungen im Quell-Vault); alles danach — Plugin-Install, Beispiel-Crews
#  ausführen, Undo/Abort testen — passiert ausschließlich im Klon unter
#  DEST_DIR. Der Klon ist sein eigenes, frisches Git-Repo: das Plugin darf
#  dort bedenkenlos committen/reverten, ohne die echte Vault-History
#  (obsidian-git o.ä.) zu berühren.
# ══════════════════════════════════════════════════════════════════════════
#
# Usage:
#   scripts/clone-vault.sh [SOURCE_VAULT] [DEST_DIR]
#
#   SOURCE_VAULT  Default: /Users/Shared/10_ObsidianVaults/Y3_ProtoVault
#                 (kleiner, sauberer Proto-Vault, der die Beispiel-Crew-Struktur
#                  spiegelt: 10_Aufgaben, 30_Chronos/10_Tage, _types/_status/
#                  _priority — die mitgelieferten Crews laufen darauf out-of-the-box.
#                  Für einen realistischeren Klon einen echten Vault als $1 übergeben.)
#   DEST_DIR      Default: /Users/Shared/10_ObsidianVaults/vault-crews-smoke
#                 (neben den echten Vaults, damit er im Obsidian-Ordner-Picker
#                  auftaucht — /tmp ist versteckt und dort nicht auswählbar)
#
# Danach: DEST_DIR in Obsidian öffnen (community plugins bleiben erhalten,
# NUR .obsidian/workspace* — offene Tabs/Layout — wird nicht mitkopiert),
# den Plugin-Build hineinkopieren (`OBSIDIAN_PLUGIN_DIR=<DEST_DIR>/.obsidian/plugins/vault-crews npm run deploy`
# oder BRAT), dann die Smoke-Checkliste aus AGENTS.md abarbeiten. Erneutes
# Ausführen ist sicher (kein `--delete`) — es aktualisiert nur vorhandene/neue
# Dateien aus dem Quell-Vault, lässt bereits im Klon installierte Plugin-
# Dateien und bisherige Testläufe unangetastet.

set -euo pipefail

SOURCE_VAULT="${1:-/Users/Shared/10_ObsidianVaults/Y3_ProtoVault}"
DEST_DIR="${2:-/Users/Shared/10_ObsidianVaults/vault-crews-smoke}"

if [ ! -d "$SOURCE_VAULT" ]; then
  echo "clone-vault: Quell-Vault nicht gefunden: $SOURCE_VAULT" >&2
  exit 1
fi

# Sicherheitsnetz: SOURCE_VAULT und DEST_DIR dürfen nie derselbe Ort sein —
# sonst könnte ein künftiger Aufruf mit anderen Flags im echten Vault landen.
SOURCE_REAL="$(cd "$SOURCE_VAULT" && pwd -P)"
if [ -d "$DEST_DIR" ]; then
  DEST_REAL="$(cd "$DEST_DIR" && pwd -P)"
  if [ "$SOURCE_REAL" = "$DEST_REAL" ]; then
    echo "clone-vault: SOURCE_VAULT und DEST_DIR sind identisch ($SOURCE_REAL) — abgebrochen." >&2
    exit 1
  fi
fi

echo "clone-vault: ${SOURCE_VAULT} -> ${DEST_DIR}"
mkdir -p "$DEST_DIR"

# Kopie via tar-Pipe (NICHT rsync): Das Default-rsync auf macOS 15+ ist
# openrsync, das erzeugte Ziel-Verzeichnisse IMMER auf den Quell-Modus fchmod't —
# auch ohne -p. Obsidian-Vault-Ordner tragen oft setgid (2775) + macOS-ACLs und
# sind teils fremd-owned (geteilte Daemon-Ordner); openrsync bricht dort mit
# "unable to escalate mode" / "fchmodat: Operation not permitted" ab (und
# openrsync kennt weder GNU-rsyncs `--chmod=D…,F…` noch ein zuverlässiges
# --no-perms für erzeugte Dirs). bsdtar strippt als Non-Root setgid/setuid beim
# Entpacken by default und restauriert keine ACLs → saubere Kopie für einen
# Wegwerf-Klon (Modi kommen aus der umask). Verifiziert gegen die problematischen
# setgid+ACL-Ordner des echten Pallas-Vaults.
#
# Kein Löschen im Ziel (bewusst): tar-extract überschreibt vorhandene Quell-
# Dateien und legt neue an, lässt aber Ziel-only-Dateien (installiertes Plugin
# unter .obsidian/plugins/, bisherige Crew-Läufe) unangetastet — der Klon darf
# über mehrere Smoke-Läufe bestehen bleiben. .git/ (eigene Klon-History) und
# .obsidian/workspace* (Fenster-/Tab-Layout) werden nie mitkopiert.
tar -C "${SOURCE_VAULT}" \
  --exclude './.git' \
  --exclude './.obsidian/workspace*' \
  -cf - . \
  | tar -C "${DEST_DIR}" -xf -

cd "$DEST_DIR"
git init -q
git add -A
if git diff --cached --quiet; then
  echo "clone-vault: keine Änderungen seit dem letzten Klon-Commit."
else
  git commit -q -m "chore: vault-crews smoke-clone snapshot ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "clone-vault: Initial-/Snapshot-Commit erstellt."
fi

echo "clone-vault: fertig — eigenständiges Git-Repo unter ${DEST_DIR} (Undo-Netz bereit)."
echo "clone-vault: der echte Vault (${SOURCE_VAULT}) wurde nicht verändert."
