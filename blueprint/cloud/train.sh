#!/usr/bin/env bash
# The R1 blueprint run (PLAN.md 5.2): medium tree, 200 buckets, 200 BB, trained
# until VISITS_PER_INFOSET x infosets infoset visits, with the Pluribus schedule
# shape scaled to the run length. Resumable: rerun it (or let the systemd unit
# rerun it after a spot stop/start) and it continues from runs/r1/ckpt.bin.
#
# Usage on the rented box (after setup.sh and bench.sh):
#   ./train.sh                       # foreground; Ctrl-C checkpoints and exits 75
#   ./train.sh --install-service     # run under systemd, restart on boot (spot stop/start)
#   ./train.sh --status              # progress so far
#   DRY_RUN=1 ./train.sh             # laptop smoke test: small tree, 2 threads, ~30 s per round
#
# Inputs (environment, defaults in r1.env): THREADS (default: all cores),
# BENCH_CSV (default runs/bench/latest/bench.csv), RUN_NAME (default r1),
# VISITS_PER_INFOSET, MAX_HOURS (per invocation wall cap, default 2x the estimate),
# AUTO_POWEROFF_MIN (power off this many minutes after the run finishes; default 90
# on Linux, empty disables), FORCE=1 (ignore a failed e gate).
#
# Exit status: 0 finished, 75 stopped by a signal or spot notice after writing a
# checkpoint (rerun to resume), anything else is an error.
set -euo pipefail

CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BP_DIR="$(dirname "$CLOUD_DIR")"
# shellcheck source=r1.env
source "$CLOUD_DIR/r1.env"

MODE="${1:-run}"

if [[ "${DRY_RUN:-0}" == 1 ]]; then
  PRESET=small BUCKETS=50 STACK=10000
  : "${THREADS:=2}"
  : "${RUN_NAME:=dry-train}"
  VISITS_PER_INFOSET="${DRY_VISITS:-1000}"   # r1.env already set these, so assign directly
  CKPT_EVERY_MIN=0.25
  : "${MAX_HOURS:=0.0084}"          # 30 seconds per invocation
  : "${LOG_EVERY_SEC:=5}"
  AUTO_POWEROFF_MIN=""
fi
: "${THREADS:=$(ncores)}"
: "${RUN_NAME:=r1}"
: "${CACHE_DIR:=$BP_DIR/cache}"
: "${BENCH_CSV:=$BP_DIR/runs/bench/latest/bench.csv}"
: "${LOG_EVERY_SEC:=300}"   # each log line builds a full policy table while training pauses
: "${SEED:=1}"
: "${MAX_ROUNDS:=4}"
if [[ "$(uname -s)" == Linux ]]; then : "${AUTO_POWEROFF_MIN=90}"; else AUTO_POWEROFF_MIN=""; fi

OUT="$BP_DIR/runs/$RUN_NAME"
BP="$BP_DIR/bin/bp"
COST="python3 $CLOUD_DIR/cost.py"
mkdir -p "$OUT"

say() { echo "[train.sh $(date -u +%H:%M:%S)] $*" | tee -a "$OUT/train.sh.log"; }

install_service() {
  local unit=/etc/systemd/system/gpo-train.service envf="$HOME/gpo-train.env"
  [[ -f "$envf" ]] || cat >"$envf" <<EOF
# Environment for gpo-train.service (read on every start). See train.sh header.
# THREADS=192
# MAX_HOURS=8
AUTO_POWEROFF_MIN=${AUTO_POWEROFF_MIN}
EOF
  sudo tee "$unit" >/dev/null <<EOF
[Unit]
Description=GPO blueprint R1 training (resumable)
After=network-online.target
Wants=network-online.target
# A run that keeps failing (disk full, bad build) must not restart forever on a paid box.
StartLimitIntervalSec=3600
StartLimitBurst=5

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$BP_DIR
EnvironmentFile=-$envf
ExecStart=$CLOUD_DIR/train.sh run
# SIGTERM goes to train.sh only; it forwards it to bp, which writes a checkpoint.
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=110
Restart=on-failure
RestartSec=30
RestartPreventExitStatus=75

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now gpo-train.service
  echo "installed and started gpo-train.service"
  echo "  progress: tail -f $OUT/train.out      status: $CLOUD_DIR/train.sh --status"
  echo "  stop (checkpoints first): sudo systemctl stop gpo-train"
}

status() {
  [[ -f "$OUT/schedule.env" ]] || { echo "no run in $OUT yet"; return 0; }
  # shellcheck disable=SC1091
  source "$OUT/schedule.env"
  if [[ -f "$OUT/log.csv" ]]; then
    eval "$($COST visits --log "$OUT/log.csv")"
    python3 - "$VISITS" "$TARGET_VISITS" "$ITER" "$EST_ITERS" <<'EOF'
import sys
v, t, it, est = map(float, sys.argv[1:])
print(f"visits {v:.4g} of {t:.4g} ({100 * v / t:.1f}%), iteration {it:.4g} (first estimate {est:.4g})")
EOF
    tail -n 3 "$OUT/log.csv"
  fi
  [[ -f "$OUT/DONE" ]] && echo "DONE: $(cat "$OUT/DONE")"
  ls -1 "$OUT/snapshots" 2>/dev/null | tail -n 3
  return 0
}

case "$MODE" in
  --install-service) install_service; exit 0 ;;
  --status) status; exit 0 ;;
  run) ;;
  *) echo "unknown argument $MODE" >&2; exit 2 ;;
esac

[[ -x "$BP" ]] || { echo "missing $BP; run setup.sh first" >&2; exit 1; }
if [[ -f "$OUT/DONE" ]]; then
  say "run already finished: $(cat "$OUT/DONE"); nothing to do"
  exit 0
fi

# ---- schedule: computed once, then frozen in schedule.env so a resume uses the same one
FLAGS="$(tree_flags)"
if [[ -f "$OUT/schedule.env" ]]; then
  # shellcheck disable=SC1091
  source "$OUT/schedule.env"
  if [[ "$SCHED_TREE_FLAGS" != "$FLAGS" ]]; then
    echo "refusing: $OUT was started with '$SCHED_TREE_FLAGS', now '$FLAGS'" >&2
    exit 1
  fi
  say "resuming with the frozen schedule in $OUT/schedule.env"
else
  [[ -f "$BENCH_CSV" ]] || { echo "no bench at $BENCH_CSV; run bench.sh first (PLAN.md 5.6 item 1)" >&2; exit 1; }
  if ! $COST summary --bench "$BENCH_CSV" >"$OUT/bench-summary.txt"; then
    cat "$OUT/bench-summary.txt"
    if [[ "${FORCE:-0}" != 1 ]]; then
      echo "refusing: the e gate failed (PLAN.md M3). FORCE=1 overrides." >&2
      exit 1
    fi
  fi
  # shellcheck disable=SC2086
  INFOSETS="$("$BP" tree $FLAGS | sed -n -E 's/^ *infosets ([0-9]+),.*/\1/p')"
  [[ -n "$INFOSETS" ]] || { echo "could not read the infoset count from bp tree" >&2; exit 1; }
  # Use the bench row for THREADS if there is one, else the largest measured row.
  row_args=()
  if cut -d, -f1 "$BENCH_CSV" | grep -qx "$THREADS"; then row_args=(--threads "$THREADS"); fi
  sched="$($COST schedule --bench "$BENCH_CSV" ${row_args[@]+"${row_args[@]}"} --infosets "$INFOSETS" \
    --visits-per-infoset "$VISITS_PER_INFOSET" --lcfr-frac "$LCFR_FRAC" --prune-frac "$PRUNE_FRAC" \
    --num-discounts "$NUM_DISCOUNTS" --snapshots "$SNAPSHOTS_PER_RUN")"
  {
    echo "# written $(date -u +%FT%TZ) by train.sh from $BENCH_CSV; do not edit during a run"
    echo "SCHED_TREE_FLAGS='$FLAGS'"
    echo "SCHED_THREADS=$THREADS"
    echo "INFOSETS=$INFOSETS"
    echo "VISITS_PER_INFOSET=$VISITS_PER_INFOSET"
    echo "PRUNE_THRESHOLD=$PRUNE_THRESHOLD"
    echo "REGRET_FLOOR=$REGRET_FLOOR"
    echo "SEED=$SEED"
    echo "COMMIT=$(git -C "$BP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "$sched"
  } >"$OUT/schedule.env"
  cp "$BENCH_CSV" "$OUT/bench.csv"
  # shellcheck disable=SC1091
  source "$OUT/schedule.env"
  say "new run in $OUT"
fi
cat "$OUT/schedule.env"

if [[ -z "${MAX_HOURS:-}" ]]; then
  MAX_HOURS="$(python3 -c "print(max(0.5, 2 * $EST_HOURS))")"
fi
MAX_MIN="$(python3 -c "print(round($MAX_HOURS * 60, 3))")"

# ---- spot interruption watcher (AWS IMDSv2 instance-action, GCP preempted flag)
# AWS posts the notice two minutes ahead and recommends polling every 5 seconds:
# https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html
spot_notice() {
  local tok
  tok="$(curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' 2>/dev/null || true)"
  if [[ -n "$tok" ]] && curl -sf -m 2 -H "X-aws-ec2-metadata-token: $tok" \
    http://169.254.169.254/latest/meta-data/spot/instance-action >/dev/null 2>&1; then
    return 0
  fi
  # https://docs.cloud.google.com/compute/docs/instances/spot : "preempted" becomes TRUE
  [[ "$(curl -s -m 2 -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/preempted 2>/dev/null || true)" == TRUE ]]
}

watch_spot() {  # $1 = pid to signal
  local pid="$1" start
  start=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    if [[ -n "${SPOT_SIM_AFTER_SEC:-}" ]]; then
      # test hook: pretend a notice arrives SPOT_SIM_AFTER_SEC seconds into the round
      if (( $(date +%s) - start >= SPOT_SIM_AFTER_SEC )); then
        date -u +%FT%TZ >"$OUT/spot-notice"; kill -TERM "$pid" 2>/dev/null; return 0
      fi
    elif spot_notice; then
      date -u +%FT%TZ >"$OUT/spot-notice"
      echo "[watcher] spot interruption notice; asking bp to checkpoint" >>"$OUT/train.sh.log"
      kill -TERM "$pid" 2>/dev/null
      return 0
    fi
    sleep 5
  done
}
use_watcher=0
if [[ -n "${SPOT_SIM_AFTER_SEC:-}" ]]; then use_watcher=1
elif [[ "${DRY_RUN:-0}" != 1 && "$(uname -s)" == Linux ]]; then use_watcher=1; fi

bp_pid=""
on_signal() {
  say "signal received; forwarding SIGTERM to bp so it checkpoints"
  stop_requested=1
  [[ -n "$bp_pid" ]] && kill -TERM "$bp_pid" 2>/dev/null || true
}
stop_requested=0
trap on_signal TERM INT

# ---- rounds: train to the iteration estimate, measure visits, top up if short
round=0
while (( round < MAX_ROUNDS )); do
  round=$((round + 1))
  if [[ -f "$OUT/log.csv" ]]; then
    eval "$($COST visits --log "$OUT/log.csv")"
  else
    ITER=0 VISITS=0 RECENT_VISITS_PER_ITER=0
  fi
  read -r target_iters remaining <<<"$(python3 - "$ITER" "$VISITS" "$TARGET_VISITS" "$RECENT_VISITS_PER_ITER" "$EST_ITERS" <<'EOF'
import math, sys
it, v, tv, vpi, est = map(float, sys.argv[1:])
if v >= tv:
    print(int(it), 0)
elif vpi <= 0:
    print(int(est), int(tv - v))
else:
    # 2% over the measured rate so the last round does not fall just short
    print(max(int(it) + 1, int(it + math.ceil((tv - v) / vpi * 1.02))), int(tv - v))
EOF
)"
  if [[ "$remaining" == 0 ]]; then
    break
  fi
  say "round $round: iteration $ITER, visits $VISITS of $TARGET_VISITS; training to iteration $target_iters (cap $MAX_MIN min, $THREADS threads)"
  rm -f "$OUT/spot-notice"
  # bp writes straight to a file: a pipe through tee could die first on shutdown
  # and take bp down with SIGPIPE before it checkpoints.
  # shellcheck disable=SC2086
  "$BP" train $FLAGS --cache "$CACHE_DIR" --threads "$THREADS" --seed "$SEED" \
    --iters "$target_iters" --minutes "$MAX_MIN" \
    --discount-every "$DISCOUNT_EVERY" --lcfr-until "$LCFR_UNTIL" --prune-after "$PRUNE_AFTER" \
    --prune-threshold "$PRUNE_THRESHOLD" --regret-floor "$REGRET_FLOOR" \
    --ckpt-every-min "$CKPT_EVERY_MIN" --snapshot-every-min "$SNAPSHOT_EVERY_MIN" \
    --log-every-sec "$LOG_EVERY_SEC" --out "$OUT" --resume >>"$OUT/train.out" 2>&1 &
  bp_pid=$!
  watcher_pid=""
  if (( use_watcher )); then watch_spot "$bp_pid" & watcher_pid=$!; fi
  rc=0
  while :; do
    set +e; wait "$bp_pid"; rc=$?; set -e
    if (( rc > 128 )) && kill -0 "$bp_pid" 2>/dev/null; then continue; fi
    if (( rc > 128 )); then set +e; wait "$bp_pid" 2>/dev/null; r2=$?; set -e; (( r2 != 127 )) && rc=$r2; fi
    break
  done
  bp_pid=""
  [[ -n "$watcher_pid" ]] && { kill "$watcher_pid" 2>/dev/null || true; wait "$watcher_pid" 2>/dev/null || true; }
  tail -n 2 "$OUT/train.out" | sed 's/^/  bp: /'
  if (( rc == 75 )) || (( stop_requested )); then
    if [[ -f "$OUT/spot-notice" && "$stop_requested" == 0 && -z "${SPOT_SIM_AFTER_SEC:-}" ]]; then
      # Notices are best effort; if the box is still up after the deadline, carry on.
      say "spot notice: checkpoint written; waiting 180 s for the interruption"
      sleep 180
      say "still running after the notice; resuming"
      round=$((round - 1))
      continue
    fi
    say "stopped (bp exit $rc) after writing a checkpoint; rerun train.sh to resume"
    exit 75
  fi
  if (( rc != 0 )); then
    say "bp exited with status $rc; see $OUT/train.out"
    exit "$rc"
  fi
done

eval "$($COST visits --log "$OUT/log.csv")"
if python3 -c "import sys; sys.exit(0 if $VISITS >= $TARGET_VISITS else 1)"; then
  echo "iteration=$ITER visits=$VISITS target=$TARGET_VISITS finished=$(date -u +%FT%TZ)" >"$OUT/DONE"
  say "finished: $(cat "$OUT/DONE")"
else
  say "stopped after $MAX_ROUNDS rounds short of the visit target ($VISITS of $TARGET_VISITS); rerun to continue"
  exit 1
fi

if [[ -n "${AUTO_POWEROFF_MIN:-}" ]]; then
  say "powering off in $AUTO_POWEROFF_MIN minutes to stop compute billing; cancel with: sudo shutdown -c"
  sudo shutdown -h "+$AUTO_POWEROFF_MIN" || say "could not schedule the power-off; stop the instance yourself"
fi
