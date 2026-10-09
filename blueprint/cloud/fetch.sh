#!/usr/bin/env bash
# Copy checkpoints, logs and bench results from the rented box to this machine.
# Safe to run repeatedly while training (rsync only sends what changed, and
# --partial resumes a broken transfer). Run it on your laptop, not on the box.
#
# Usage:
#   HOST=ubuntu@203.0.113.7 KEY=~/.ssh/gpo.pem ./fetch.sh              # logs, ckpt.bin, bench, abstraction
#   HOST=... KEY=... ./fetch.sh --snapshots                            # also every snapshot (learning curve)
#   HOST=... KEY=... ./fetch.sh --export                               # run `bp export` on the box first
#   HOST=... KEY=... ./fetch.sh --dry-run                              # list what would be copied
#   HOST=local REMOTE_DIR=/path/to/blueprint ./fetch.sh                # local copy (testing)
#
# Environment: HOST (required), KEY (ssh key, optional), REMOTE_DIR (default
# gpo/blueprint, relative to the remote home), RUN_NAME (default r1),
# DEST (default <this repo>/blueprint/runs/<RUN_NAME>-cloud).
set -euo pipefail

CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BP_DIR="$(dirname "$CLOUD_DIR")"
: "${HOST:?set HOST=ubuntu@<public IP> (or HOST=local for a local test)}"
: "${REMOTE_DIR:=gpo/blueprint}"
: "${RUN_NAME:=r1}"
: "${DEST:=$BP_DIR/runs/$RUN_NAME-cloud}"

snapshots=0 export_first=0 dry=()
for arg in "$@"; do
  case "$arg" in
    --snapshots) snapshots=1 ;;
    --export) export_first=1 ;;
    --dry-run) dry=(--dry-run) ;;
    *) echo "unknown argument $arg" >&2; exit 2 ;;
  esac
done

ssh_opts=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)
[[ -n "${KEY:-}" ]] && ssh_opts+=(-i "$KEY")

if [[ "$HOST" == local ]]; then
  src="$REMOTE_DIR"
  remote() { (cd "$REMOTE_DIR" && bash -c "$1"); }
  rs=(rsync)
else
  src="$HOST:$REMOTE_DIR"
  remote() { ssh "${ssh_opts[@]}" "$HOST" "cd $REMOTE_DIR && $1"; }
  rs=(rsync -e "ssh ${ssh_opts[*]}")
fi

if (( export_first )); then
  echo "== exporting the policy on the box"
  # shellcheck disable=SC2016
  remote 'set -e; . runs/'"$RUN_NAME"'/schedule.env; bin/bp export $SCHED_TREE_FLAGS --cache cache --ckpt runs/'"$RUN_NAME"'/ckpt.bin --out runs/'"$RUN_NAME"'/blueprint.gpobp'
fi

mkdir -p "$DEST/bench" "$DEST/cache"
filters=(--include='/snapshots/')
if (( snapshots )); then filters+=(--include='/snapshots/*.bin'); fi
filters+=(--exclude='/snapshots/*' --exclude='*.tmp')

echo "== run directory -> $DEST"
"${rs[@]}" -av --partial --progress ${dry[@]+"${dry[@]}"} "${filters[@]}" "$src/runs/$RUN_NAME/" "$DEST/"
echo "== bench results -> $DEST/bench"
"${rs[@]}" -av --partial ${dry[@]+"${dry[@]}"} "$src/runs/bench/" "$DEST/bench/"
echo "== abstraction tables (needed to load the checkpoint with the same buckets) -> $DEST/cache"
"${rs[@]}" -av --partial ${dry[@]+"${dry[@]}"} --include='abs-*.bin' --exclude='*' "$src/cache/" "$DEST/cache/"
"${rs[@]}" -av ${dry[@]+"${dry[@]}"} "$src/setup.txt" "$DEST/" 2>/dev/null || true

if [[ ${#dry[@]} -eq 0 && -f "$DEST/ckpt.bin" ]]; then
  echo "== checksum of ckpt.bin (remote, then local)"
  remote "sha256sum runs/$RUN_NAME/ckpt.bin 2>/dev/null || shasum -a 256 runs/$RUN_NAME/ckpt.bin" | awk '{print $1}'
  (sha256sum "$DEST/ckpt.bin" 2>/dev/null || shasum -a 256 "$DEST/ckpt.bin") | awk '{print $1}'
  echo "(they differ if training wrote a new checkpoint in between; fetch again after DONE)"
fi
[[ -f "$DEST/DONE" ]] && echo "run finished: $(cat "$DEST/DONE")"
flags=""
if [[ -f "$DEST/schedule.env" ]]; then
  flags="$(sed -n -E "s/^SCHED_TREE_FLAGS='(.*)'$/\1/p" "$DEST/schedule.env")"
fi
echo "done. Every bp command that loads this checkpoint needs the run's tree flags and its"
echo "abstraction cache. The flags are written out here so the line works in zsh too:"
echo "  bin/bp show ${flags:-<SCHED_TREE_FLAGS from schedule.env>} --cache $DEST/cache --ckpt $DEST/ckpt.bin"
