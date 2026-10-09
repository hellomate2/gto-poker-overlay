#!/usr/bin/env bash
# Prepare a fresh Ubuntu 24.04 box for the R1 blueprint run: toolchain, a clone
# of the repo at a pinned branch (and optionally a pinned commit), a build tuned
# for this CPU, and the C++ test suite.
#
# Usage (as the default `ubuntu` user, which has passwordless sudo on AWS/GCP images):
#   scp -i KEY blueprint/cloud/setup.sh ubuntu@HOST:~ && ssh -i KEY ubuntu@HOST 'bash setup.sh'
#   BRANCH=swarm/next COMMIT=<sha> bash setup.sh       # pin something else
#   DRY_RUN=1 bash setup.sh                            # print the commands only
#
# Environment: REPO_URL, BRANCH (default master/cloud), COMMIT (optional sha),
# DEST (default ~/gpo), ARCH (override the detected -march/-mcpu flag),
# SKIP_TESTS=1 (skip `make test`).
set -euo pipefail

: "${REPO_URL:=https://github.com/hellomate2/gto-poker-overlay.git}"
: "${BRANCH:=master/r1-launch}"
: "${COMMIT:=}"
: "${DEST:=$HOME/gpo}"
DRY="${DRY_RUN:-0}"

run() {
  echo "+ $*"
  if [[ "$DRY" != 1 ]]; then "$@"; fi
}

# ---- 1. OS check
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "OS: ${PRETTY_NAME:-unknown}"
  [[ "${VERSION_ID:-}" == 24.04 ]] || echo "warning: written for Ubuntu 24.04; continuing anyway"
else
  echo "warning: no /etc/os-release (not Linux?)"
  [[ "$DRY" == 1 ]] || { echo "refusing to install packages on a non-Linux host; use DRY_RUN=1" >&2; exit 1; }
fi

# ---- 2. toolchain (g++ 13 on 24.04, make, git, python3 for cost.py, rsync for fetch.sh)
run sudo apt-get update -y
run sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  build-essential git python3 rsync curl tmux htop

# ---- 3. repo at the pinned branch / commit
if [[ -d "$DEST/.git" ]]; then
  run git -C "$DEST" fetch origin "$BRANCH"
  run git -C "$DEST" checkout -B "$BRANCH" "origin/$BRANCH"
elif [[ -n "$COMMIT" ]]; then
  run git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$DEST"
else
  run git clone --depth 1 --branch "$BRANCH" --single-branch "$REPO_URL" "$DEST"
fi
if [[ -n "$COMMIT" ]]; then run git -C "$DEST" checkout --detach "$COMMIT"; fi
if [[ "$DRY" != 1 ]]; then echo "code: $BRANCH at $(git -C "$DEST" rev-parse HEAD)"; fi

# ---- 4. ARCH for this CPU. The binary is built on the box that runs it, so
# -march=native / -mcpu=native already targets it; the named flags below make the
# target explicit in the build log for the two instance types PLAN.md 5.1 prices
# (c7a = AMD Zen 4, c8g = Graviton4, per gpo-research/eval-compute-paper.md 2.2).
detect_arch() {
  local cand="" fallback=""
  case "$(uname -m)" in
    x86_64)
      fallback="-march=native"
      # 4th-generation EPYC model names end in 4 (e.g. 9R14 on c7a); Zen 4 is znver4.
      if grep -m1 'model name' /proc/cpuinfo 2>/dev/null | grep -qE 'AMD EPYC 9[0-9A-Z]{2}4'; then
        cand="-march=znver4"
      fi
      ;;
    aarch64)
      fallback="-mcpu=native"
      case "$(grep -m1 'CPU part' /proc/cpuinfo 2>/dev/null | awk '{print $NF}')" in
        0xd4f) cand="-mcpu=neoverse-v2" ;;   # Graviton4
        0xd40) cand="-mcpu=neoverse-v1" ;;   # Graviton3
      esac
      ;;
    *) fallback="-march=native" ;;
  esac
  if [[ -n "$cand" ]] && echo 'int main(){return 0;}' | g++ $cand -x c++ - -o /dev/null 2>/dev/null; then
    echo "$cand"
  else
    echo "$fallback"
  fi
}
if [[ -z "${ARCH:-}" ]]; then
  if [[ "$DRY" == 1 ]]; then ARCH="-march=native"; else ARCH="$(detect_arch)"; fi
fi
echo "ARCH=$ARCH"

# ---- 5. build and test
BP_DIR="$DEST/blueprint"
JOBS="$(nproc 2>/dev/null || echo 4)"
run make -C "$BP_DIR" -j "$JOBS" CXX=g++ ARCH="$ARCH" bin/bp bin/bp_tests
if [[ "${SKIP_TESTS:-0}" != 1 ]]; then run make -C "$BP_DIR" CXX=g++ ARCH="$ARCH" test; fi
if [[ "$DRY" != 1 ]]; then
  {
    echo "setup_utc=$(date -u +%FT%TZ)"
    echo "branch=$BRANCH"
    echo "commit=$(git -C "$DEST" rev-parse HEAD)"
    echo "arch=$ARCH"
    echo "cxx=$(g++ --version | head -1)"
    echo "cpu=$(grep -m1 -E 'model name|CPU part' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//')"
    echo "cores=$JOBS"
    echo "mem=$(free -g | awk '/Mem:/ {print $2 " GiB"}')"
  } | tee "$BP_DIR/setup.txt"
fi

cat <<EOF

Setup done. Next, on this box:
  cd $BP_DIR/cloud
  ./bench.sh                         # five 60 s runs plus the abstraction build; exit 2 = e gate failed
  python3 cost.py estimate --bench ../runs/bench/latest/bench.csv --price <USD/h>
  ./train.sh --install-service       # or ./train.sh inside tmux
EOF
