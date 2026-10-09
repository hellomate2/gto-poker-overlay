#!/usr/bin/env bash
# Measure training throughput on this box at several thread counts and print
# iterations/s, visits/s, speedup and scaling efficiency e (PLAN.md 5.6 item 1,
# and the M3 gate "If e < 0.5, fix contention before any long run").
#
# Usage (on the rented box, after setup.sh):
#   ./bench.sh                                # R1 tree, threads 1,16,48,96,192 (capped at nproc), 60 s each
#   THREADS_LIST=1,32,64 SECONDS_PER=30 ./bench.sh
#   DRY_RUN=1 ./bench.sh                      # laptop smoke test: small tree, 50 buckets, threads 1,2, 15 s each
#
# Output: runs/bench/<timestamp>/{bench.csv,bench.out,meta.txt}, and
#         runs/bench/latest -> that directory (train.sh reads latest/bench.csv).
# Exit status 2 if the e gate fails at the largest thread count.
set -euo pipefail

CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BP_DIR="$(dirname "$CLOUD_DIR")"
# shellcheck source=r1.env
source "$CLOUD_DIR/r1.env"

if [[ "${DRY_RUN:-0}" == 1 ]]; then
  PRESET=small BUCKETS=50 STACK=10000
  : "${THREADS_LIST:=1,2}"
  : "${SECONDS_PER:=15}"
fi
: "${THREADS_LIST:=1,16,48,96,192}"
: "${SECONDS_PER:=60}"
: "${CACHE_DIR:=$BP_DIR/cache}"
: "${BENCH_ROOT:=$BP_DIR/runs/bench}"

NCORES="$(ncores)"
# Drop thread counts above the core count (unless ALLOW_OVERSUBSCRIBE=1).
list=""
IFS=',' read -r -a req <<<"$THREADS_LIST"
for t in "${req[@]}"; do
  if [[ "$t" -le "$NCORES" || "${ALLOW_OVERSUBSCRIBE:-0}" == 1 ]]; then list="${list:+$list,}$t"
  else echo "skipping $t threads (this box has $NCORES cores)"; fi
done
[[ -n "$list" ]] || { echo "no thread counts left to run" >&2; exit 1; }

BP="$BP_DIR/bin/bp"
[[ -x "$BP" ]] || { echo "missing $BP; run setup.sh or 'make' in $BP_DIR first" >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BENCH_ROOT/$stamp"
mkdir -p "$out"

# Machine and code description, so a bench result is attributable later.
{
  echo "date_utc=$stamp"
  echo "host=$(hostname)"
  echo "cores=$NCORES"
  echo "uname=$(uname -srm)"
  if [[ -r /proc/cpuinfo ]]; then
    echo "cpu=$(grep -m1 -E 'model name|^CPU part' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//')"
  else
    echo "cpu=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)"
  fi
  echo "load_before=$(uptime | sed 's/.*load average[s]*: //')"
  echo "commit=$(git -C "$BP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "tree_flags=$(tree_flags)"
  echo "threads_list=$list"
  echo "seconds_per=$SECONDS_PER"
  echo "dry_run=${DRY_RUN:-0}"
} >"$out/meta.txt"
cat "$out/meta.txt"

# The abstraction build is multithreaded; use every core. `bp bench` builds and
# caches it on first use, so time that step separately (it is part of the overhead).
# shellcheck disable=SC2046
t0=$(date +%s)
"$BP" abs $(tree_flags) --threads "$NCORES" --cache "$CACHE_DIR" | tee "$out/abs.out"
echo "abstraction_seconds=$(( $(date +%s) - t0 ))" | tee -a "$out/meta.txt"

# shellcheck disable=SC2046
"$BP" tree $(tree_flags) | tee "$out/tree.out"

# Each thread count trains on fresh tables after a 2,000-iteration warm-up, with
# pruning off (bp bench defaults), for SECONDS_PER seconds.
# shellcheck disable=SC2046
"$BP" bench $(tree_flags) --cache "$CACHE_DIR" --threads "$NCORES" \
  --threads-list "$list" --seconds "$SECONDS_PER" | tee "$out/bench.out"

# "train threads=16: 123 iterations/s (4.56 M infoset visits/s) over 60.0s"
echo "threads,iters_per_sec,visits_per_sec,seconds" >"$out/bench.csv"
sed -n -E 's/^train threads=([0-9]+): ([0-9.]+) iterations\/s \(([0-9.]+) M infoset visits\/s\) over ([0-9.]+)s$/\1,\2,\3,\4/p' \
  "$out/bench.out" | awk -F, '{ printf "%s,%s,%.0f,%s\n", $1, $2, $3 * 1e6, $4 }' >>"$out/bench.csv"
[[ "$(wc -l <"$out/bench.csv")" -gt 1 ]] || { echo "could not parse bench output" >&2; exit 1; }
echo "load_after=$(uptime | sed 's/.*load average[s]*: //')" >>"$out/meta.txt"

ln -sfn "$stamp" "$BENCH_ROOT/latest"
echo
echo "== $out/bench.csv"
cat "$out/bench.csv"
echo
status=0
python3 "$CLOUD_DIR/cost.py" summary --bench "$out/bench.csv" | tee "$out/summary.txt" || status=$?
echo
echo "Next: python3 $CLOUD_DIR/cost.py estimate --bench $out/bench.csv --price <USD per hour>"
exit "$status"
