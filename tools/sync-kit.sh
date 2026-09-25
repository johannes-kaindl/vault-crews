#!/bin/sh
# uebernommen aus lingotuner/tools/sync-kit.sh, 2026-09-15 — Modul-Liste auf vault-crews
# angepasst (kein clipboard/stream-blocks/stable-writer; think-splitter statt clipboard;
# clock.ts als repo-eigene Sonderkopie, s. u.). Re-vendor kit modules from
# ../obsidian-kit + ../../libs/code-kit. Run after kit updates.
set -e

KIT="${KIT_DIR:-../obsidian-kit}"
# Zweite Quelle seit obsidian-kit 2ab1bb5 ("domaenenfreie pure-Teilmenge zieht nach code-kit"):
# ALLE hier vendorten pure-Module liegen dort, nicht mehr unter obsidian-kit/src/pure/.
#
# obsidian-kit traegt unter src/vendor/code-kit/ eigene Kopien einiger Module; die werden hier
# bewusst NICHT genommen. Eine Zwischenkopie als Quelle zu nehmen erzeugt eine Kopier-Kette,
# und die sieht bei der naechsten Zaehlung wie ein unabhaengiger Beleg aus.
# Abweichung von der lingotuner-Vorlage: code-kit liegt hier unter jkaindl/libs/, nicht
# nebenan unter obsidian-plugins/ — der Default ist deshalb ../../libs/code-kit.
CODE_KIT="${CODE_KIT_DIR:-../../libs/code-kit}"
[ -d "$KIT/src/obsidian" ] || { echo "Kit nicht gefunden unter $KIT (KIT_DIR setzen)" >&2; exit 1; }
[ -d "$CODE_KIT/src/ts" ] || { echo "code-kit nicht gefunden unter $CODE_KIT (CODE_KIT_DIR setzen)" >&2; exit 1; }
# CORE-META-22: gelesen wird aus einer FESTEN REF, nicht aus dem Arbeitsstand des
# Nachbar-Repos. Ein `cp` aus dessen Worktree koppelt dieses Repo an einen fremden HEAD.
# Default ist die package.json-Version der Quelle; ein Upgrade ist eine BEWUSSTE Handlung.
VER="${KIT_REF:-$(node -p "require('$KIT/package.json').version")}"
CODE_VER="${CODE_KIT_REF:-$(node -p "require('$CODE_KIT/package.json').version")}"
for paar in "$KIT|$VER" "$CODE_KIT|$CODE_VER"; do
  repo=${paar%%|*}; ref=${paar##*|}
  git -C "$repo" rev-parse --verify --quiet "$ref^{commit}" >/dev/null || {
    echo "FEHLER: Ref '$ref' existiert nicht in $repo." >&2
    echo "  Entweder ist die Version dort ungetaggt, oder KIT_REF/CODE_KIT_REF setzen." >&2
    exit 2
  }
done
SHA=$(git -C "$KIT" rev-parse --short "$VER^{commit}")

# Ein pures Modul kann in zwei Schichten liegen. Statt fester Zuordnung wird gesucht — die
# naechste Umschichtung soll dieses Skript nicht wieder toeten, sondern nur einen anderen
# Fundort ergeben. Ausgabe: <repo>|<ref>|<quelle>|<quell-relativer-pfad>|<version>
quelle_fuer() {
  for kandidat in \
    "$KIT|$VER|obsidian-kit|src/pure/$1.ts|$VER" \
    "$CODE_KIT|$CODE_VER|code-kit|src/ts/pure/$1.ts|$CODE_VER" \
    "$CODE_KIT|$CODE_VER|code-kit|src/ts/web/$1.ts|$CODE_VER"; do
    repo=$(printf '%s' "$kandidat" | cut -d'|' -f1)
    ref=$(printf '%s' "$kandidat" | cut -d'|' -f2)
    rel=$(printf '%s' "$kandidat" | cut -d'|' -f4)
    # In der REF nachsehen, nicht im Worktree — sonst faende die Suche eine Datei, die der
    # Lesevorgang danach nicht bekommt.
    if git -C "$repo" cat-file -e "$ref:$rel" 2>/dev/null; then
      printf '%s\n' "$kandidat"; return 0
    fi
  done
  return 1
}

# In eine .tmp lesen und erst bei Erfolg verschieben — eine Ausgabe-Umleitung legt die
# Zieldatei an, BEVOR der Lesebefehl laeuft, und hinterlaesst sonst einen Torso, der mit
# Stempelzeile wie ein gueltiges Vendoring aussieht.
hole() { # hole <repo> <ref> <quell-pfad> <ziel>
  git -C "$1" show "$2:$3" > "$4.tmp" || { rm -f "$4.tmp"; return 1; }
  mv "$4.tmp" "$4"
}

stamp() { # stamp <vendored-file> <quell-relativer-pfad> [<quelle> <version>]
  quelle=${3:-obsidian-kit}
  version=${4:-$VER}
  header="// vendored from $quelle@$version, $2 — do not hand-edit; re-vendor via tools/sync-kit.sh"
  printf '%s\n' "$header" | cat - "$1" > "$1.tmp"
  mv "$1.tmp" "$1"
}

# Kit-interne Querimporte aufs Vendor-Layout umschreiben. Im Kit liegen die Schichten als
# src/obsidian + src/pure nebeneinander, hier als src/vendor/kit-obsidian + src/vendor/kit —
# `../pure/` zeigt hier also ins Leere. Das ist die EINZIGE zulaessige Abweichung von verbatim;
# bei jedem Re-Vendor reproduzieren, sonst darf nichts abweichen.
# Praezedenz: kuro-gamification, markdown-presentation, vault-crews, vim-dojo, lingotuner —
# neun Importzeilen, byte-identisch (md5 3aad7dd28a3a9875a3015a07bb78fc99).
relayer() { # relayer <vendored-file>
  f=$1
  case "$f" in
    src/vendor/kit-obsidian/*) ;;
    *) echo "sync-kit: $f liegt nicht in src/vendor/kit-obsidian/ — der Querimport-Umschrieb setzt die Zwei-Ordner-Form voraus (obsidian-kit/README.md)" >&2; exit 1 ;;
  esac
  [ -d src/vendor/kit ] || { echo "sync-kit: src/vendor/kit/ fehlt — pure-Schicht anlegen, bevor gekoppelte Module mit Querimport vendoriert werden" >&2; exit 1; }

  sed -e 's|\(["'"'"']\)\.\./pure/|\1../kit/|g' \
      -e 's|\(["'"'"']\)\.\./vendor/code-kit/pure/|\1../kit/|g' \
      -e 's|\(["'"'"']\)\.\./vendor/code-kit/web/|\1../kit/|g' "$f" > "$f.tmp"
  if cmp -s "$f" "$f.tmp"; then rm -f "$f.tmp"; return 0; fi
  mv "$f.tmp" "$f"

  if grep -qE '\.\./(pure|vendor/code-kit)/' "$f"; then
    echo "sync-kit: unaufgeloester Kit-Querimport in $f — Muster pruefen" >&2; exit 1
  fi

  for dep in $(sed -n 's|.*from ["'"'"']\.\./kit/\([A-Za-z0-9_/-]*\)["'"'"'].*|\1|p' "$f" | sort -u); do
    [ -f "src/vendor/kit/$dep.ts" ] || {
      echo "sync-kit: $f importiert ../kit/$dep, aber src/vendor/kit/$dep.ts fehlt — mitvendorieren" >&2; exit 1
    }
  done

  note="// ONE mechanical deviation from verbatim: kit-internal imports (../pure/ and ../vendor/code-kit/{pure,web}/) → ../kit/ (vendor layout); reproduce on every re-vendor, nothing else may differ."
  printf '%s\n' "$note" | cat - "$f" > "$f.tmp"
  mv "$f.tmp" "$f"
}

# Zweite Fallgruppe: ein PURE_MODULE, das selbst aus obsidian-kit/src/pure/ stammt, aber einen
# Querimport auf code-kit traegt (dessen eigene Vendor-Kopie unter obsidian-kit/src/vendor/code-kit/
# liegt). Hier landen BEIDE Seiten flach nebeneinander in src/vendor/kit/ — der Zielpfad ist also
# NICHT ../kit/ (das waere fuer kit-obsidian/, das eine Ebene hoeher liegt), sondern ./ (Geschwisterdatei
# in derselben Ablage). Anlass: endpoint-source.ts importiert endpoint_config aus
# ../vendor/code-kit/pure/ (obsidian-kit-Perspektive) — Praezedenz: llm-endpoint-manager/tools/sync-kit.sh.
relayer_pure() { # relayer_pure <vendored-file>
  f=$1
  case "$f" in
    src/vendor/kit/*) ;;
    *) echo "sync-kit: $f liegt nicht in src/vendor/kit/ — relayer_pure gilt nur fuer die pure-Schicht" >&2; exit 1 ;;
  esac

  sed -e 's|\(["'"'"']\)\.\./vendor/code-kit/pure/|\1./|g' \
      -e 's|\(["'"'"']\)\.\./vendor/code-kit/web/|\1./|g' "$f" > "$f.tmp"
  if cmp -s "$f" "$f.tmp"; then rm -f "$f.tmp"; return 0; fi   # nichts zu tun, KEINE Notiz
  mv "$f.tmp" "$f"

  if grep -qE '\.\./vendor/code-kit/' "$f"; then
    echo "sync-kit: unaufgeloester Kit-Querimport in $f — Muster pruefen" >&2; exit 1
  fi

  for dep in $(sed -n 's|.*from ["'"'"']\./\([A-Za-z0-9_/-]*\)["'"'"'].*|\1|p' "$f" | sort -u); do
    [ -f "src/vendor/kit/$dep.ts" ] || {
      echo "sync-kit: $f importiert ./$dep, aber src/vendor/kit/$dep.ts fehlt — mitvendorieren" >&2; exit 1
    }
  done

  note="// ONE mechanical deviation from verbatim: kit-internal import (../vendor/code-kit/{pure,web}/) → ./ (flat vendor layout, sibling module in src/vendor/kit/); reproduce on every re-vendor, nothing else may differ."
  printf '%s\n' "$note" | cat - "$f" > "$f.tmp"
  mv "$f.tmp" "$f"
}

liste() { for m in $1; do printf '%s.ts, ' "$m"; done | sed 's/, $//'; }

mkdir -p src/vendor/kit src/vendor/kit-obsidian

# think-splitter: die Datei heisst hier historisch think.ts (vor diesem Skript entstanden),
# nicht wie ueberall sonst think-splitter.ts — beim Erstlauf dieses Skripts umbenannt
# (zwei Importstellen mitgezogen), damit Modulname und Dateiname wieder uebereinstimmen.
PURE_MODULE="capabilities endpoint endpoint_config endpoint_diagnostics error_body i18n model-context model-choice model-list-cache reasoning sampling-profiles endpoint-source settings sse think-splitter timeout"
# Die gekoppelte Schicht (importiert `obsidian`). stream-area ist der Anlass dieses
# Skripts (Welle 2, Streaming-Antwortbereich); stable-writer/stream-blocks bewusst nicht
# vendoriert — vault-crews ist Bauart 2 (append-only), kein Markdown-Push.
OBSIDIAN_MODULE="confirm endpoint-list model-picker settings_walker folder-suggest stream-area endpoint-source"

for m in $PURE_MODULE; do
  quelle_fuer "$m" >/dev/null || {
    echo "FEHLER: $m.ts liegt weder in $KIT/src/pure/ noch in $CODE_KIT/src/ts/{pure,web}/." >&2
    echo "  Seit obsidian-kit 2ab1bb5 ist code-kit die Quelle der domaenenfreien Module." >&2
    exit 2
  }
done

for m in $PURE_MODULE; do
  fund=$(quelle_fuer "$m")
  repo=$(printf '%s' "$fund" | cut -d'|' -f1)
  ref=$(printf '%s' "$fund" | cut -d'|' -f2)
  quelle=$(printf '%s' "$fund" | cut -d'|' -f3)
  rel=$(printf '%s' "$fund" | cut -d'|' -f4)
  ver=$(printf '%s' "$fund" | cut -d'|' -f5)
  hole "$repo" "$ref" "$rel" "src/vendor/kit/$m.ts" || {
    echo "FEHLER: $ref:$rel nicht lesbar in $repo" >&2; exit 2; }
  # endpoint-source.ts (obsidian-kit/src/pure/) traegt einen Querimport auf code-kit, dessen
  # obsidian-kit-eigene Vendor-Kopie hier nicht existiert — auf die flache Ablage umschreiben.
  case "$m" in endpoint-source) relayer_pure "src/vendor/kit/$m.ts" ;; esac
  stamp "src/vendor/kit/$m.ts" "$rel" "$quelle" "$ver"
  echo "vendored $quelle@$ver/$rel"
done

for m in $OBSIDIAN_MODULE; do
  hole "$KIT" "$VER" "src/obsidian/$m.ts" "src/vendor/kit-obsidian/$m.ts" || {
    echo "FEHLER: $VER:src/obsidian/$m.ts nicht lesbar" >&2; exit 2; }
  case "$m" in endpoint-list|model-picker|endpoint-source) relayer "src/vendor/kit-obsidian/$m.ts" ;; esac
  stamp "src/vendor/kit-obsidian/$m.ts" "src/obsidian/$m.ts"
  echo "vendored obsidian-kit@$VER/obsidian/$m.ts"
done

# clock.ts: repo-eigene Sonderkopie, keine "pure"-Datei im Kit. Liegt unter src/vendor/kit/
# statt kit-obsidian/, weil sie kein Obsidian-Symbol importiert (UI-STANDARD §9 zieht die
# Grenze am Import, nicht am Verzeichnis des Kits) — siehe VENDOR.json-Notiz.
hole "$KIT" "$VER" "src/obsidian/clock.ts" "src/vendor/kit/clock.ts" || {
  echo "FEHLER: $VER:src/obsidian/clock.ts nicht lesbar" >&2; exit 2; }
stamp "src/vendor/kit/clock.ts" "src/obsidian/clock.ts"
echo "vendored obsidian-kit@$VER/obsidian/clock.ts"

# tests/__mocks__/obsidian.ts bleibt hier bewusst AUSSERHALB dieses Skripts: es ist keine
# verbatim-Kopie von src/testing/obsidian-mock.ts (Superset-Merge mehrerer Plugin-Mocks,
# eigener Header „vendored from obsidian-kit#…"), sondern ein Hand-Nachzug. Ein zweiter,
# ungenutzter Kopie-Ort unter tests/vendor/kit/ (wie in lingotuner) wuerde hier nichts
# lesen — vitest aliast `obsidian` weiterhin auf tests/__mocks__/obsidian.ts, nicht auf
# einen vendorten Pfad. Modul-Liste-Anpassung laut Auftragspunkt 2.

cat > src/vendor/kit/VENDOR.json <<JSON
{
  "source": "obsidian-kit",
  "version": "$VER",
  "sha": "$SHA",
  "code_kit_version": "$CODE_VER",
  "vendored": "$(liste "$PURE_MODULE") (code-kit), obsidian/clock.ts (obsidian-kit)",
  "note": "Verbatim snapshot aus ZWEI Quellen (obsidian-kit + code-kit); welche Datei woher stammt, sagt ihr eigener Kopf. Never hand-edit. Re-vendor via tools/sync-kit.sh. version/sha gelten fuer clock.ts; code_kit_version fuer die uebrigen. clock.ts liegt hier statt in kit-obsidian, weil sie kein Obsidian-Symbol importiert."
}
JSON
cat > src/vendor/kit-obsidian/VENDOR.json <<JSON
{
  "source": "obsidian-kit",
  "version": "$VER",
  "sha": "$SHA",
  "vendored": "$(liste "$OBSIDIAN_MODULE")",
  "note": "Verbatim snapshot. Never hand-edit. Re-vendor via tools/sync-kit.sh. endpoint-list.ts, model-picker.ts und endpoint-source.ts tragen EINE mechanische Abweichung: kit-interne Importe ../vendor/code-kit/{pure,web}/ sind auf ../kit/ umgeschrieben (Vendor-Layout). Bei jedem Re-Vendoring reproduzieren; sonst darf nichts abweichen. stream-area.ts ist verbatim (keine Kit-internen Importe)."
}
JSON
echo "VENDOR.json → $VER ($SHA)"
