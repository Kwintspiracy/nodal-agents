#!/usr/bin/env bash
# campaign/measure-print-wait.sh — la mesure de #1071, base contre tête.
#
#   bash packages/bench/campaign/measure-print-wait.sh [--keys <fichier de clés>] [--trials 5]
#
# Lancé depuis la racine d'un worktree de la branche (la TÊTE). Appelle un
# modèle, avec une clé : c'est l'orchestrateur qui le lance, jamais un dev.
#
# Deux campagnes du scénario `print`, sur une instance jetable chacune
# (configuration campaign/print-wait.json : une imprimante du banc qui IMPRIME,
# un travail terminé en 20 s, que son outil d'état sait suivre) :
#   base  le code de la tête, SAUF le skill print-request, celui de la base de
#         la branche (merge-base avec origin/main), dans un worktree détaché
#         à côté : seule la consigne diffère, l'imprimante est la même ;
#   head  la tête telle quelle.
# Puis la mesure (src/printer/wait-measure-cli.ts) des deux dossiers de
# preuves, écrite dans bench/campaigns/print-wait-<horodatage>.json.
set -euo pipefail

TRIALS=5
KEYS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --trials) TRIALS="$2"; shift 2 ;;
    --keys) KEYS=(--keys "$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

HEAD_TREE="$(git rev-parse --show-toplevel)"
HEAD_SHA="$(git -C "$HEAD_TREE" rev-parse HEAD)"
git -C "$HEAD_TREE" fetch -q origin main
BASE_SHA="$(git -C "$HEAD_TREE" merge-base HEAD origin/main)"
BASE_TREE="${HEAD_TREE}-measure-base"
SKILL=packages/catalog/src/skills/print-request.ts
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if [ ! -d "$BASE_TREE" ]; then
  git -C "$HEAD_TREE" worktree add --detach "$BASE_TREE" "$HEAD_SHA"
fi
git -C "$BASE_TREE" checkout -q --detach "$HEAD_SHA"
git -C "$BASE_TREE" show "$BASE_SHA:$SKILL" > "$BASE_TREE/$SKILL"
echo "base tree: $BASE_TREE = $HEAD_SHA with $SKILL of $BASE_SHA"
git -C "$BASE_TREE" diff --stat
(cd "$BASE_TREE" && pnpm install --frozen-lockfile --prefer-offline > /dev/null)

campaign() { # <tree> <label> : lance la campagne, rend le dossier des preuves
  local tree="$1" label="$2" log
  log="$HEAD_TREE/bench/campaigns/print-wait-$STAMP-$label.log"
  mkdir -p "$(dirname "$log")"
  (cd "$tree/packages/bench" && pnpm exec tsx src/campaign/cli.ts \
      --config campaign/print-wait.json --only print --trials "$TRIALS" "${KEYS[@]}") \
    2>&1 | tee "$log" >&2 || true
  sed -n 's/^Evidence: //p' "$log" | tail -1
}

BASE_EVIDENCE="$(campaign "$BASE_TREE" base)"
HEAD_EVIDENCE="$(campaign "$HEAD_TREE" head)"
[ -n "$BASE_EVIDENCE" ] || { echo "the base campaign printed no Evidence line: see its log" >&2; exit 1; }
[ -n "$HEAD_EVIDENCE" ] || { echo "the head campaign printed no Evidence line: see its log" >&2; exit 1; }

OUT="$HEAD_TREE/bench/campaigns/print-wait-$STAMP.json"
(cd "$HEAD_TREE/packages/bench" && pnpm exec tsx src/printer/wait-measure-cli.ts \
  "base=$BASE_EVIDENCE" "head=$HEAD_EVIDENCE" --out "$OUT")
echo "Logs: $HEAD_TREE/bench/campaigns/print-wait-$STAMP-{base,head}.log"
echo "Base tree left at $BASE_TREE: remove it with git worktree remove --force \"$BASE_TREE\""
