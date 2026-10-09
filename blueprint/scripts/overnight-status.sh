#!/bin/bash
# One-screen status of the overnight blueprint run (read-only).
OUT="${1:-$HOME/.gpo/overnight}"
echo "launchd:   $(launchctl list | grep gpo.train || echo 'gpo.train NOT LOADED')"
echo "process:   $(pgrep -fl "$OUT/bp train" | head -1 || true)"
[ -f "$OUT/DONE" ] && echo "DONE:      $(cat "$OUT/DONE")"
[ -f "$OUT/FAILED" ] && echo "FAILED:    $(cat "$OUT/FAILED")"
[ -f "$OUT/fail_count" ] && echo "failed starts: $(cat "$OUT/fail_count")"
if [ -f "$OUT/ckpt.bin" ]; then
  age=$(( $(date +%s) - $(stat -f %m "$OUT/ckpt.bin") ))
  echo "checkpoint: $OUT/ckpt.bin, $age s old"
fi
echo "snapshots: $(ls "$OUT/snapshots" 2>/dev/null | wc -l | tr -d ' ')"
echo "log.csv last row:"
tail -1 "$OUT/log.csv" 2>/dev/null
echo "train.out tail:"
tail -4 "$OUT/train.out" 2>/dev/null | cut -c1-200
