#!/bin/bash
# Overnight heads-up blueprint run that survives crashes of whatever started it.
#
# macOS privacy rules (TCC) stop launchd jobs from reading ~/Downloads, so the
# run lives in its own folder outside it, RUN_DIR (default ~/.gpo/overnight),
# with a frozen copy of the binary, the abstraction cache and this script.
# blueprint/runs/overnight is a symlink to RUN_DIR for convenience.
#
# Install and launch, from a terminal inside blueprint/ after `make`:
#   bash scripts/overnight-run.sh --install
# which copies bin/bp, the cache file and this script into RUN_DIR, then runs
#   launchctl submit -l gpo.train -- /bin/bash $RUN_DIR/run.sh
# launchd restarts the job whenever it exits, independent of any app.
# Status:  bash scripts/overnight-status.sh
# Stop:    launchctl remove gpo.train
#
# Each start resumes from the newest loadable checkpoint (bp train --resume
# tries ckpt.bin, then snapshots newest first) or starts fresh if there is
# none, and trains until the fixed deadline. At the deadline it writes DONE
# and then sleeps forever, so launchd does not restart a finished job.
set -u

RUN_DIR="${RUN_DIR:-$HOME/.gpo/overnight}"
DEADLINE_EPOCH="${DEADLINE_EPOCH:-1791559800}"   # 2026-10-09 08:30:00 PDT
THREADS="${THREADS:-6}"
FLOP=200; TURN=200; RIVER=200; BINS=50; ABS_SEED=7
CACHE_FILE="abs-f${FLOP}-t${TURN}-r${RIVER}-b${BINS}-s${ABS_SEED}.bin"
# Tree and abstraction: small preset, 200/200/200 buckets (chosen from
# `bp bench --thread-list 6` on 2026-10-09; see STATE.md and LOG.md).
TREE_ARGS=(--preset small --flop $FLOP --turn $TURN --river $RIVER --bins $BINS --abs-seed $ABS_SEED
           --cache "$RUN_DIR/cache")
# Schedule: the 25-minute run's shape (README) stretched about 5x for a run
# of a few billion iterations: about 40 Linear-CFR discounts, pruning on
# after 100M iterations, same threshold and floor as the 25-minute run.
SCHED_ARGS=(--discount-every 10000000 --lcfr-until 400000000 --prune-after 100000000
            --prune-threshold -30000000 --regret-floor -31000000)

if [ "${1:-}" = "--install" ]; then
  BP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  mkdir -p "$RUN_DIR/cache"
  [ -x "$BP_DIR/bin/bp" ] || { echo "build first: make"; exit 1; }
  [ -f "$BP_DIR/cache/$CACHE_FILE" ] || { echo "build the abstraction first: bin/bp abs --flop $FLOP --turn $TURN --river $RIVER"; exit 1; }
  if [ -e "$RUN_DIR/bp" ]; then echo "$RUN_DIR/bp exists; refusing to replace the binary of a run in progress"; exit 1; fi
  cp "$BP_DIR/bin/bp" "$RUN_DIR/bp"
  cp "$BP_DIR/cache/$CACHE_FILE" "$RUN_DIR/cache/"
  cp "$0" "$RUN_DIR/run.sh"
  mkdir -p "$BP_DIR/runs"
  [ -e "$BP_DIR/runs/overnight" ] || ln -s "$RUN_DIR" "$BP_DIR/runs/overnight"
  launchctl submit -l gpo.train -- /bin/bash "$RUN_DIR/run.sh"
  echo "submitted gpo.train: $RUN_DIR/run.sh"
  exit 0
fi

mkdir -p "$RUN_DIR"
cd "$RUN_DIR" || exit 1
say() { echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] run.sh: $*" >> "$RUN_DIR/train.out"; }
sleep_forever() { while true; do sleep 86400; done; }

if [ -f "$RUN_DIR/DONE" ]; then
  say "DONE exists; idling so launchd does not restart a finished job"
  sleep_forever
fi
if [ "$(date +%s)" -ge "$DEADLINE_EPOCH" ]; then
  say "deadline passed before start; writing DONE"
  date '+%Y-%m-%d %H:%M:%S %Z deadline reached' > "$RUN_DIR/DONE"
  sleep_forever
fi
if [ ! -x "$RUN_DIR/bp" ]; then
  say "no binary at $RUN_DIR/bp; run scripts/overnight-run.sh --install"
  sleep 300
  exit 1
fi

say "starting (pid $$), threads $THREADS, deadline epoch $DEADLINE_EPOCH"
started=$(date +%s)
/usr/bin/caffeinate -i /usr/bin/nice -n 5 "$RUN_DIR/bp" train "${TREE_ARGS[@]}" "${SCHED_ARGS[@]}" \
  --threads "$THREADS" --seed 1 --minutes 100000 --until-epoch "$DEADLINE_EPOCH" \
  --log-every-sec 60 --ckpt-every-min 15 --snapshot-every-min 60 \
  --resume --out "$RUN_DIR" >> "$RUN_DIR/train.out" 2>&1
rc=$?
say "bp exited with code $rc"

if [ "$rc" -eq 0 ] && [ "$(date +%s)" -ge "$DEADLINE_EPOCH" ]; then
  date '+%Y-%m-%d %H:%M:%S %Z deadline reached' > "$RUN_DIR/DONE"
  say "wrote DONE; idling"
  sleep_forever
fi

# Unexpected exit: back off so a persistent failure does not spin, then let
# launchd restart us (the next start resumes from the newest checkpoint).
# A start that trained for more than 10 minutes resets the failure count.
if [ $(( $(date +%s) - started )) -gt 600 ]; then echo 0 > "$RUN_DIR/fail_count"; fi
fails=$(( $(cat "$RUN_DIR/fail_count" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$RUN_DIR/fail_count"
if [ "$fails" -ge 20 ]; then
  say "20 failed starts in a row; writing FAILED and idling"
  date > "$RUN_DIR/FAILED"
  sleep_forever
fi
sleep 30
exit 1
