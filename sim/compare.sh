#!/usr/bin/env bash
# ============================================================
# Standard baseline-vs-candidate battery, built on sim/match.ts.
#
#   sim/compare.sh BASELINE_DIR CANDIDATE_DIR [OUT_DIR] [WORKERS]
#
# A = baseline, B = candidate, so NEGATIVE "A vs B" / "A - B" numbers mean the
# candidate is better. Every run is duplicate format with a 95% CI. Deal counts
# come from env vars so they can be scaled to the machine:
#   HU_DEALS     heads-up A vs B            (default 3000 deals = 6000 hands per engine)
#   PROBE_DEALS  vs each archetype, HU      (default 3000 deals per archetype)
#   RING_DEALS   6-max vs the default field (default 3000 deals)
#   SEED         (default 1)
# Each step writes OUT_DIR/<name>.txt.
# ============================================================
set -euo pipefail
A=${1:?baseline dir}
B=${2:?candidate dir}
OUT=${3:-sim/compare-out}
W=${4:-4}
HU_DEALS=${HU_DEALS:-3000}
PROBE_DEALS=${PROBE_DEALS:-3000}
RING_DEALS=${RING_DEALS:-3000}
SEED=${SEED:-1}
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"

run() {
  local name=$1; shift
  echo ">>> $name"
  npx tsx "$HERE/match.ts" --a "$A" --b "$B" --seed "$SEED" --workers "$W" --out "$OUT/$name.txt" "$@" \
    | grep -E "MATCH|A vs|A - B|->|fold-to|barrel|wall"
}

run hu-head-to-head --mode hu --deals "$HU_DEALS"
for p in raiser barreler checkraiser tag station maniac nit; do
  run "hu-vs-$p" --mode field --seats 2 --field "$p" --deals "$PROBE_DEALS"
done
run ring6-default-field --mode field --seats 6 --deals "$RING_DEALS"
