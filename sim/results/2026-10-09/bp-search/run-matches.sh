#!/bin/bash
# Pre-registered blueprint+search matches. One match at a time, 3 shard processes (one thread left for tests).
set -u
OUT=$(cd "$(dirname "$0")" && pwd)/raw
# the runs used a detached worktree at commit 81b3077 (same agent and serve code as this branch)
cd /Users/rg/Downloads/gpo-wt/bp-search-run
export GPO_BP_FLAGS="--preset small --flop 200 --turn 200 --river 200 --bins 50 --abs-seed 7 --cache /Users/rg/.gpo/overnight/cache"
unset GPO_ENGINE_FLAGS GPO_BP_SEARCH GPO_BP_SEARCH_MS GPO_BP_SEARCH_MAX_ITERS GPO_BP_SEARCH_MIN_ITERS
CK=/Users/rg/.gpo/eval/final.bin
ORIG=/Users/rg/Downloads/gto-poker-overlay
wait_load() {
  while true; do
    l=$(sysctl -n vm.loadavg | awk '{print $2}')
    if awk -v l="$l" 'BEGIN{exit !(l <= 16)}'; then return; fi
    echo "$(date +%T) load $l > 16, waiting" >> $OUT/driver.log
    sleep 60
  done
}
run() {  # name seed bspec(extra args...)
  name=$1; seed=$2; shift 2
  wait_load
  echo "$(date +%T) start $name seed $seed load $(sysctl -n vm.loadavg)" >> $OUT/driver.log
  t0=$(date +%s)
  for k in 0 1 2; do
    GPO_BP_SEARCH_LOG=$OUT/$name-s$seed-search.jsonl npx tsx sim/match.ts --a . "$@" \
      --a-agent blueprint+search:$CK --deals 3000 --seed $seed --shard $k/3 > $OUT/$name-s$seed-shard$k.json 2> $OUT/$name-s$seed-shard$k.err &
  done
  wait
  t1=$(date +%s)
  echo "$(date +%T) end $name seed $seed wall $((t1-t0)) s" >> $OUT/driver.log
}
run a 7 --b /Users/rg/Downloads/gpo-wt/bp-search-run --b-agent blueprint:$CK
run b 7 --b $ORIG
run a 101 --b /Users/rg/Downloads/gpo-wt/bp-search-run --b-agent blueprint:$CK
run b 101 --b $ORIG
echo "$(date +%T) all done" >> $OUT/driver.log
