# Cloud package for the R1 blueprint run

Scripts to run PLAN.md's R1 (medium betting tree, 169 / 200 / 200 / 200 buckets,
200 BB stacks) on one rented many-core box, plus the cost math to decide whether
to spend. Nothing here rents, buys or signs up for anything. You launch the
machine yourself; the scripts run on it after you log in.

PLAN.md means `~/Downloads/gpo-research/PLAN.md` (section numbers below refer to it).

| File | Runs on | What it does |
| --- | --- | --- |
| `setup.sh` | the box | installs the toolchain, clones the repo at a pinned branch (and commit), builds `bin/bp` for this CPU, runs `make test` |
| `bench.sh` | the box | `bp bench` at 1, 16, 48, 96 and 192 threads; prints iterations/s, visits/s, speedup and the efficiency e; exit 2 if the e gate fails |
| `cost.py` | anywhere | hours and dollars from the bench numbers and a price you pass; the training schedule; a self-check against PLAN.md 5.2 |
| `train.sh` | the box | the R1 run: Pluribus-shaped schedule, checkpoints, snapshots, graceful stop on a spot notice, resume, optional systemd unit |
| `fetch.sh` | your laptop | rsync of logs, checkpoint, snapshots, bench results and abstraction tables back home |
| `r1.env` | (sourced) | the R1 tree, abstraction and schedule settings in one place |
| `m3-readme-bench.csv` | (data) | the blueprint README's measured M3 Pro numbers, for testing `cost.py` |

Two small changes in `src/main.cpp` support this: `bp bench --threads-list 1,16,48,96,192`
picks thread counts explicitly (before, the list was fixed at 1, 2, 4), and `bp train`
now catches SIGTERM and SIGINT, finishes the current chunk of about one second, writes
its checkpoint and snapshot, and exits with status 75.

## What to check before spending

These come from PLAN.md 5.6 and the milestone order in section 4.

1. Code version. PLAN.md puts M0 (harden the trainer: all-in always legal after the
   raise cap, never prune the max-regret action, 200 BB preset) before any rented
   run, and says "A new betting tree from M0 changes these counts; rerun `bp tree`
   and redo this arithmetic" (5.1). This package is on `master/cloud`, which is
   `ws/blueprint` plus these scripts, so it trains the pre-M0 tree. If the M0 fixes
   have landed on another branch by the time you launch, set `BRANCH=` to that branch
   when you run `setup.sh`. `train.sh` reads the infoset count from `bp tree` on the
   box, so its targets follow whatever tree the code builds.
2. Spot vCPU quota. AWS's default for "All Standard (A, C, D, H, I, M, R, T, Z) Spot
   Instance Requests" is 5 vCPUs
   (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-spot-limits.html).
   A 192-core box needs 192. Request the increase first; it can take time.
3. Bench gate. Run `bench.sh` on the box before training. PLAN.md M3: "If e < 0.5,
   fix contention ... before any long run." `bench.sh` exits 2 and `train.sh` refuses
   to start in that case (override with `FORCE=1` only if you have a reason).
4. Price. Spot prices move hourly (PLAN.md 5.1 lists the 2026-10-09 values). Look up
   today's price on the launch page and pass it to `cost.py estimate`.
5. Budget. PLAN.md 5.5 budgets $7 to $22 for R1 and $10 to $20 for bench boxes, with
   a 20% contingency on the total.

R2 (the large run) has its own gates in PLAN.md 5.6: items 1 to 3 (f and e measured,
per-visit cost on a 7 to 22 GB table, and R1's learning curve past 160,000 visits per
infoset). This package covers the R1 side of that.

## Expected cost (from PLAN.md 5.2)

| Scenario (PLAN.md 5.1) | f | e | Wall on 192 cores | c7a.48xlarge spot | c8g.48xlarge spot |
| --- | ---: | ---: | ---: | ---: | ---: |
| optimistic | 1.0 | 0.85 | 1.9 h | $7 | $5 |
| middle | 0.75 | 0.7 | 3.1 h | $11 | $8 |
| pessimistic | 0.5 | 0.5 | 6.5 h | $22 | $17 |

Prices behind those rows (PLAN.md 5.1, AWS us-east-1, 2026-10-09): c7a.48xlarge
$3.414/h spot, $9.85344/h on demand; c8g.48xlarge $2.576/h spot; c7a.16xlarge (64
cores) $1.150/h spot. f is one server core's speed relative to one M3 Pro thread and
e is parallel efficiency; both are guesses until `bench.sh` measures them.

`python3 cost.py plan-check` recomputes every R1 and R2 row of PLAN.md 5.2 from its
inputs and checks them; every row matches.

Once you have a bench from the real box:

```bash
python3 cost.py estimate --bench ../runs/bench/latest/bench.csv --price 3.414 --margin 0.2
```

It uses the measured visits per second at the largest thread count, so the result
is `81,406,148 infosets x 160,000 visits / measured visits/s`. It needs no f or e.

Worked check on the blueprint README's own measurements (`m3-readme-bench.csv`, copied
from the throughput table in `blueprint/README.md`: medium 200-bucket tree, 45,221 it/s and
13.1M visits/s on 1 thread, 166,468 it/s and 46.2M visits/s on 4):

```
$ python3 cost.py summary --bench m3-readme-bench.csv
threads       iter/s     visits/s  speedup      e visits/iter
      1       45,221       13.10M     1.00  1.000       289.7
      4      166,468       46.20M     3.53  0.882       277.5
$ python3 cost.py estimate --bench m3-readme-bench.csv
training wall = 78.31 h
PLAN.md cross-check: M3 thread-hours = 313 (PLAN.md 5.2 R1: 313)
```

So R1 is 313 M3 thread-hours (78 hours on the laptop's 4 threads), which is why it
goes to a rented box.

Before you have a bench from the target box, `--cores N --e E` projects from the
1-thread row instead: per-thread speed x cores x e. With the M3 row, 192 cores and
PLAN.md 5.1's c7a.48xlarge spot price of $3.414/h:

```
$ python3 cost.py estimate --bench m3-readme-bench.csv --cores 192 --e 0.85 --price 3.414 --margin 0.2
training wall = 1.69 h ...   cost at $3.4140/h = $5.78   with a 20% margin: $6.93
$ python3 cost.py estimate --bench m3-readme-bench.csv --cores 192 --e 0.5 --price 3.414 --margin 0.2
training wall = 2.88 h ...   cost at $3.4140/h = $9.82   with a 20% margin: $11.79
```

These come out a little under PLAN.md's optimistic row (1.9 h, $7) because the
1-thread row runs 13.1M visits/s per thread, while PLAN.md's 11.55M is the 4-thread
average. Both assume a server core is as fast as an M3 Pro thread (f = 1), which is
exactly what `bench.sh` exists to measure.

## AWS, step by step (console)

Steps and labels follow the AWS docs for a Spot request from the launch wizard
(https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-requests.html).

1. Quota. Console search "Service Quotas", then AWS services, Amazon Elastic Compute
   Cloud (Amazon EC2), "All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance
   Requests", request an increase to 192. Same region you will
   launch in (PLAN.md's prices are us-east-1).
2. EC2 console, top bar: pick the region. Left menu, Key Pairs, Create key pair
   (RSA, .pem). Save the file, then on the Mac: `chmod 400 ~/Downloads/gpo.pem`.
3. EC2 console dashboard, Launch instance.
   1. Name and tags: `gpo-r1`.
   2. Application and OS Images: Ubuntu, "Ubuntu Server 24.04 LTS". Architecture
      64-bit (x86) for c7a, 64-bit (Arm) for c8g.
   3. Instance type: `c7a.48xlarge` (or `c8g.48xlarge`; or `c7a.16xlarge` if the
      quota is only 64).
   4. Key pair: the one from step 2.
   5. Network settings: allow SSH traffic from "My IP" only.
   6. Configure storage: 100 GiB gp3 root volume. R1's tables are 2.6 GB (`bp tree`),
      each checkpoint and snapshot is one table's size, and `train.sh` keeps about 8
      snapshots plus one at the end of each round, so roughly 30 GB with room to spare.
   7. Advanced details, Purchasing option: tick "Request Spot Instances", then
      Customize:
      - Maximum price: No maximum price.
      - Request type: Persistent request.
      - Valid to: No request expiry date (you cancel it yourself at the end).
      - Interruption behavior: Stop.
      Persistent plus Stop is what makes the run survive an interruption: AWS stops
      the instance, keeps the disk, and restarts the same instance when capacity
      returns, and while it is stopped you pay only for the disk
      (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/interruption-behavior.html).
      With the default Terminate the disk and the checkpoints are gone.
   8. Launch instance. Note the instance's Public IPv4 address. It can change after
      a stop and start.
4. Copy and run setup (from the Mac, in this folder):

   ```bash
   KEY=~/Downloads/gpo.pem; H=ubuntu@<public IP>
   scp -i $KEY setup.sh $H:~
   ssh -i $KEY $H 'bash setup.sh'                     # BRANCH=... COMMIT=... to pin
   ```

   It prints the commit it built, the ARCH flag (`-march=znver4` on c7a's Zen 4,
   `-mcpu=neoverse-v2` on Graviton4, `-march=native` / `-mcpu=native` otherwise) and
   the C++ test results, and writes `~/gpo/blueprint/setup.txt`.
5. Bench (the gate):

   ```bash
   ssh -i $KEY $H
   tmux new -s gpo                                    # survives a dropped ssh
   cd ~/gpo/blueprint/cloud && ./bench.sh
   python3 cost.py estimate --bench ../runs/bench/latest/bench.csv --price <spot $/h> --margin 0.2
   ```

   Stop here if e < 0.5 or the estimate is outside what you want to spend. The bench
   itself is five 60-second runs plus the abstraction build; at PLAN.md's c7a spot
   price every 10 minutes of box time is $0.57.
6. Train:

   ```bash
   ./train.sh --install-service      # systemd unit: starts now, and again after a spot stop/start
   ./train.sh --status               # visits so far vs the target, last log rows, snapshots
   tail -f ../runs/r1/train.out      # live log
   ```

   Running `./train.sh` inside tmux works too, but it will not restart by itself
   after an interruption. Settings go in `~/gpo-train.env` (read on every start),
   for example `VISITS_PER_INFOSET=240000` or `AUTO_POWEROFF_MIN=`.
7. Fetch results to the Mac whenever you like, and once more after `DONE`:

   ```bash
   HOST=$H KEY=$KEY ./fetch.sh               # logs, ckpt.bin, bench, abstraction tables
   HOST=$H KEY=$KEY ./fetch.sh --snapshots   # plus every snapshot (the learning curve)
   HOST=$H KEY=$KEY ./fetch.sh --export      # also writes blueprint.gpobp for the TS loader
   ```

   Files land in `blueprint/runs/r1-cloud/`. Internet data transfer out of AWS is
   billed per GB (https://aws.amazon.com/ec2/pricing/on-demand/), so skip
   `--snapshots` if you will compute the learning curve on the box instead.
8. Stop billing. Do all of it, in this order:
   1. EC2, Spot Requests: select the request, Actions, Cancel request. Do this first.
      If you terminate an instance whose persistent request is still active, the
      request reopens and launches a new instance
      (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-spot-instances-request.html).
   2. EC2, Instances: select `gpo-r1`, Instance state, Terminate (delete) instance.
      Cancelling the request does not terminate a running instance by itself (same page).
   3. EC2, Elastic Block Store, Volumes: delete any volume left in state "available".
   4. Key pair and security group cost nothing and can stay.
   5. Next day, check Billing and Cost Management for any running charge.

When training finishes, `train.sh` schedules a power-off 90 minutes later
(`AUTO_POWEROFF_MIN`, set it empty to disable) so a forgotten box stops computing.
A stopped instance still bills its disk, and the persistent request still exists,
so step 8 is still needed.

## What train.sh does

1. Reads the bench (`runs/bench/latest/bench.csv`), refuses if the e gate failed,
   reads the infoset count from `bp tree`, and asks `cost.py schedule` for:
   - target visits = infosets x `VISITS_PER_INFOSET` (160,000, PLAN.md 5.1);
   - an iteration estimate = target visits / (bench visits per iteration);
   - Linear CFR for the first 400/11,520 of the iterations with 40 discounts, and
     pruning from 200/11,520. That is Pluribus's shape (LCFR for the first 400
     minutes, a discount every 10 minutes, pruning after 200 minutes, of an 8-day
     run; `gpo-research/pluribus.md` section 2) scaled to this run's length;
   - a snapshot interval of 1/8 of the estimated wall time, so the run leaves about
     8 learning-curve points for PLAN.md's M6 gate.
   The schedule is frozen in `runs/r1/schedule.env`, so every resume uses the same one.
2. Runs `bp train --resume` up to the iteration estimate with a wall cap of twice the
   estimated hours (`MAX_HOURS`), checkpointing every 15 minutes (`CKPT_EVERY_MIN`).
   Logging every 300 s (`LOG_EVERY_SEC`), since each log line computes a full policy
   table while training waits.
3. Counts the visits actually done from `log.csv`. Pruning skips subtrees, so an
   iteration visits fewer infosets than in the bench (which runs without pruning).
   If the visit target is not met it trains again to a new iteration target from the
   recent visits per iteration, up to `MAX_ROUNDS` (4) rounds. Then it writes `DONE`.
4. While `bp` runs, a watcher polls the AWS spot notice
   (`/latest/meta-data/spot/instance-action` with an IMDSv2 token, every 5 s as AWS
   recommends: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html)
   and GCP's `instance/preempted` flag. On a notice it sends SIGTERM to `bp`, which
   writes its checkpoint and exits 75. AWS gives two minutes of notice (same page).
   If the box is still up 180 s later, training resumes.
5. A plain `systemctl stop`, Ctrl-C, or an OS shutdown also reaches `bp` as SIGTERM
   (the unit uses `KillMode=mixed`, so `train.sh` forwards it), and the checkpoint is
   written before exit.

Pruning thresholds: `-30,000,000` / `-31,000,000` chips by default, the values of the
25-minute run, which reached the same ~160,000 visits per infoset. Pluribus used
`-300,000,000` / `-310,000,000` (pluribus.md); its README note says that threshold
"would rarely trigger in a run this short". Override with `PRUNE_THRESHOLD` and
`REGRET_FLOOR`.

After the run, the M6 gate (PLAN.md section 4) wants exact-EV h2h and `bp br` along
the snapshots. On the box, with the run's flags from `schedule.env`:

```bash
source ../runs/r1/schedule.env
../bin/bp h2h $SCHED_TREE_FLAGS --a ../runs/r1/ckpt.bin --b ../runs/r1/snapshots/<earlier>.bin --hands 2000000 --threads 64
../bin/bp br  $SCHED_TREE_FLAGS --target ../runs/r1/ckpt.bin --minutes 10 --threads 64 --out ../runs/r1/br
```

Every `bp` command that loads an R1 checkpoint needs the same tree flags and the same
abstraction cache (`fetch.sh` copies `cache/abs-*.bin`); a mismatch is refused by the
checkpoint fingerprint. In zsh, run these under `bash` so `$SCHED_TREE_FLAGS` splits.

## Hetzner

`gpo-research/eval-compute-paper.md` 2.2 (the price source PLAN.md 5.1 cites) lists Hetzner's dedicated
AX162 (48-core EPYC 9454P) at $722.10 a month plus $359 setup, which makes it a poor
fit for a run of a few hours. Hetzner Cloud servers are billed by the hour but "for as
long as it exists, regardless of whether it is turned on or not"
(https://docs.hetzner.com/cloud/billing/faq/): to stop billing, delete the server.
Hetzner has no spot market, so interruptions are not expected; `train.sh` runs
unchanged (the watcher finds no metadata service and stays idle). Pick the box,
run `setup.sh`, `bench.sh`, and pass the hourly price to `cost.py estimate`.
PLAN.md has no Hetzner Cloud price, so take it from Hetzner's page on the day.

## GCP

`eval-compute-paper.md` 2.2 lists c3d-highcpu-180 (180 vCPUs, SMT, so about 90
physical cores, flagged unverified there) at $1.6398/h spot in us-central1. Notes:

- Spot VMs get 0 s (default) or 120 s of preemption notice, set `preempted` to TRUE
  in the metadata server, then send an ACPI soft-off; termination action STOP keeps
  the disks, which still bill, and the VM hours stop
  (https://docs.cloud.google.com/compute/docs/instances/spot). Choose STOP and the
  120 s notice if offered. After the soft-off the shutdown period is best effort and
  lasts up to 30 s (same page). The watcher sees `preempted` within 5 s and `bp`
  writes its checkpoint first (2.6 GB for R1, `bp tree`), but if 30 s is not enough
  the run resumes from the last 15-minute checkpoint, since the write goes to a
  temporary file and is renamed only when complete. A stopped Spot VM stays
  TERMINATED until you start it again; the systemd unit then resumes the run.
- With SMT, bench both the physical and the logical core count:
  `THREADS_LIST=1,45,90,180 ./bench.sh`, then `THREADS=<best> ./train.sh`.
- The login user depends on how you add your SSH key and may not be `ubuntu`;
  set `HOST=<user>@<ip>` for `fetch.sh` accordingly.
- Stop billing: delete the VM, then any leftover disks.

## Tested locally (this Mac, 2026-10-09)

shellcheck is not installed on this Mac, so every script was checked with `bash -n`
and then run end to end. The dry runs use the small tree (50 buckets, 17.8 MB of
tables), so their speeds say nothing about R1. Other jobs were running on the Mac.

- `make test` with the `main.cpp` changes: 2345 checks, 0 failures.
- `python3 cost.py plan-check`: every R1 and R2 row of PLAN.md 5.2 reproduced.
- `DRY_RUN=1 THREADS_LIST=1,2 SECONDS_PER=30 ./bench.sh`: 181,575 it/s on 1 thread,
  200,582 it/s on 2 threads, 30 s each; `cost.py summary` printed e = 0.563 at 2
  threads and "gate ok".
- `DRY_RUN=1 SPOT_SIM_AFTER_SEC=10 ./train.sh` (2 threads, 30 s cap): simulated spot
  notice after 10 s; `bp` wrote its checkpoint at iteration 2,558,358 and exited 75.
  The next `DRY_RUN=1 ./train.sh` resumed there, reached the visit target at
  iteration 3,019,934 and wrote `DONE`; a third call exited at once.
- 30-second cap: `DRY_VISITS=3000` needs more than one 30 s round. Round 1 stopped at
  the cap (4,816,429 iterations in 30.7 s), round 2 finished at 8,451,960 iterations.
- SIGTERM to `train.sh` 12 s into a round: forwarded to `bp`, which checkpointed and
  exited 75, and `train.sh` exited 75 with no `bp` left running.
- SIGKILL to the whole process group 23 s in (no clean checkpoint): the rerun resumed
  from the 15-second checkpoint at iteration 2,433,325, kept counting visits from
  `log.csv`, and finished at iteration 8,113,919.
- `HOST=local ./fetch.sh --export --snapshots` against the dry run: logs, checkpoint,
  both snapshots, bench results and abstraction table copied, `blueprint.gpobp`
  exported, checksums equal, and the `bp show` line `fetch.sh` prints loads the copy
  in zsh.
- `DRY_RUN=1 bash setup.sh` prints its commands. It has not run on Ubuntu, and the
  code has not been compiled with g++ here; `setup.sh` runs `make test` on the box,
  which would catch a g++-only problem in the first minutes.
