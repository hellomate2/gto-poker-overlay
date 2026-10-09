#!/usr/bin/env bash
# ============================================================
# Standard baseline-vs-candidate battery, built on sim/match.ts.
#
#   sim/compare.sh BASELINE_DIR CANDIDATE_DIR [OUT_DIR] [WORKERS]
#
# A = baseline, B = candidate, so NEGATIVE "A vs B" / "A - B" numbers mean the
# candidate is better. Every run is duplicate format with a 95% CI. Deal counts
# come from env vars so they can be scaled to the machine:
#   HU_DEALS     heads-up A vs B              (default 5000 deals = 10000 hands per engine)
#   PROBE_DEALS  vs each archetype, HU        (default 6000 deals per archetype)
#   RING_DEALS   6-max vs the default field   (default 4000 deals)
#   PROBES       archetypes for the HU field runs (default "raiser barreler checkraiser tag")
#   SEED         (default 1)
# Each step writes OUT_DIR/<name>.txt. Timings measured on this 11-core machine
# while other jobs held the load average near 10-12 (see sim/BASELINE.md): with
# 3 workers, heads-up A vs B ran 15.5 games/s, field vs one archetype 26 games/s,
# 6-max field 10 games/s with 2 workers. At the defaults every step is under 20
# minutes; the whole battery is roughly an hour.
# ============================================================
set -euo pipefail
A=${1:?baseline dir}
B=${2:?candidate dir}
OUT=${3:-sim/compare-out}
W=${4:-4}
HU_DEALS=${HU_DEALS:-5000}
PROBE_DEALS=${PROBE_DEALS:-6000}
RING_DEALS=${RING_DEALS:-4000}
PROBES=${PROBES:-raiser barreler checkraiser tag}
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
for p in $PROBES; do
  run "hu-vs-$p" --mode field --seats 2 --field "$p" --deals "$PROBE_DEALS"
done
run ring6-default-field --mode field --seats 6 --deals "$RING_DEALS"
