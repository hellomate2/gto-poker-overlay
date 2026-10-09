#!/usr/bin/env python3
"""Cost math for the R1 cloud run, from measured `bp bench` numbers.

Every constant here is cited. The formulas are PLAN.md section 5.1
(~/Downloads/gpo-research/PLAN.md):

    visits      = infosets x visits_per_infoset
    thread-h    = visits / (11.55e6 x 3600)          (M3 Pro thread reference)
    core-h      = thread-h / f
    wall        = core-h / (cores x e)
    dollars     = wall x hourly price

With a bench from the target box, f and e are measured instead of assumed, and
the wall time is simply visits / (measured visits per second at N threads).

Subcommands
  summary    --bench CSV                    table of it/s, visits/s, speedup, e, f
  estimate   --bench CSV --price P          hours and dollars for the run
             [--cores N --e E]              ... projected from the 1-thread row instead
  schedule   --bench CSV                    shell assignments for train.sh
  visits     --log LOG.CSV                  cumulative visits done, from a `bp train` log
  memory                                    table GB per run, dense vs compact (PLAN.md M3)
  plan-check                                reproduce PLAN.md 5.2 rows from its own inputs

The bench CSV is written by bench.sh: threads,iters_per_sec,visits_per_sec,seconds
(`bp scale bench --csv` adds trainer,load_before,load_after,table_mb; pick rows
with --trainer compact|dense).
"""
import argparse
import csv
import math
import sys

# PLAN.md 5.1: "46.2M infoset visits/s on 4 threads for the medium 200-bucket tree,
# so 11.55M visits per thread-second" (measured on the Apple M3 Pro, blueprint/README.md).
M3_VISITS_PER_THREAD_SEC = 11.55e6
# PLAN.md 5.2's R1 count, measured before the M0 tree change (all-in legal at
# capped nodes); kept so plan-check still reproduces PLAN.md's own rows.
PLAN_R1_INFOSETS = 81_406_148
# The same command on the current tree (after M0, swarm/next 368b379):
# `bp tree --preset medium --stack 20000 --flop 200 --turn 200 --river 200`
# prints "infosets 85778056" and 2,778.5 MB of dense training tables.
R1_INFOSETS = 85_778_056
# Slots per street (preflop, flop, turn, river) and total tree nodes, printed by
# `bp scale tree --preset medium --stack 20000 --flop F --turn T --river R` on the
# current tree (PLAN.md M3 memory table). Preflop has 169 buckets in every run.
TREE_NODES = 1_157_902
RUN_SLOTS = {
    "R1 (200/200/200)": (214_461, 4_374_400, 35_576_000, 191_376_000),
    "R2 (5000/5000/1000)": (214_461, 109_360_000, 889_400_000, 956_880_000),
    "R3 (30000/30000/2000)": (214_461, 656_160_000, 5_336_400_000, 1_913_760_000),
}
# PLAN.md 5.1, crude quality rule from blueprint/README.md.
VISITS_PER_INFOSET = 160_000
# PLAN.md 5.6 / M3: "If e < 0.5 (ours), fix contention ... before any long run."
E_GATE = 0.5
# Pluribus schedule shape, gpo-research/pluribus.md section 2: LCFR for 400 of
# 11,520 minutes (8 days), a discount every 10 minutes, pruning from minute 200.
LCFR_FRAC = 400 / 11520
PRUNE_FRAC = 200 / 11520
NUM_DISCOUNTS = 40


def read_bench(path, trainer=None):
    rows = []
    with open(path) as fh:
        for r in csv.DictReader(fh):
            # `bp scale bench --dense` writes compact and dense rows to one CSV
            if trainer and r.get("trainer", trainer) != trainer:
                continue
            rows.append({
                "threads": int(r["threads"]),
                "its": float(r["iters_per_sec"]),
                "vps": float(r["visits_per_sec"]),
                "seconds": float(r["seconds"]),
            })
    if not rows:
        sys.exit(f"no rows in {path}")
    rows.sort(key=lambda r: r["threads"])
    return rows


def efficiency_table(rows, ref=M3_VISITS_PER_THREAD_SEC):
    """Adds speedup, e and f. Baseline is the 1-thread row; without it, the
    smallest thread count is the baseline and e is relative to that."""
    base = rows[0]
    per_thread_base = base["vps"] / base["threads"]
    out = []
    for r in rows:
        speedup = r["vps"] / per_thread_base
        e = speedup / r["threads"]
        out.append(dict(r, speedup=speedup, e=e, f=per_thread_base / ref))
    return out, base["threads"]


def pick_row(rows, threads):
    if threads is None:
        return rows[-1]
    for r in rows:
        if r["threads"] == threads:
            return r
    sys.exit(f"no bench row with {threads} threads; have {[r['threads'] for r in rows]}")


def cmd_summary(a):
    rows, base_threads = efficiency_table(read_bench(a.bench, a.trainer), a.ref_vps)
    print(f"baseline for speedup and e: {base_threads} thread(s); "
          f"f = baseline visits/s per thread / {a.ref_vps / 1e6:.2f}M (M3 Pro thread, PLAN.md 5.1)")
    print(f"{'threads':>7} {'iter/s':>12} {'visits/s':>12} {'speedup':>8} {'e':>6} {'visits/iter':>11}")
    for r in rows:
        print(f"{r['threads']:>7} {r['its']:>12,.0f} {r['vps'] / 1e6:>11.2f}M {r['speedup']:>8.2f} "
              f"{r['e']:>6.3f} {r['vps'] / r['its']:>11.1f}")
    top = rows[-1]
    print(f"f = {top['f']:.3f}   e at {top['threads']} threads = {top['e']:.3f}")
    print("note: f compares with the M3 Pro measured on the R1 tree (medium, 200 buckets); "
          "it means nothing for a bench on another tree (DRY_RUN=1 uses the small tree)")
    if base_threads != 1:
        print("note: no 1-thread row, so e and f are relative to the smallest thread count")
    if top["e"] < E_GATE:
        print(f"GATE FAIL: e = {top['e']:.3f} < {E_GATE} at {top['threads']} threads. "
              "PLAN.md M3: fix contention before any long run.")
        return 2
    print(f"gate ok: e >= {E_GATE} (PLAN.md M3)")
    return 0


def run_numbers(a):
    rows = read_bench(a.bench, getattr(a, "trainer", None))
    if a.cores:
        # Projection: the smallest-thread row's per-thread speed, times cores x e.
        # Use it to price a box you have not benched yet, e.g. the README's M3 row
        # scaled to 192 cores with one of PLAN.md 5.1's e scenarios.
        if a.e is None:
            sys.exit("--cores needs --e (parallel efficiency, e.g. 0.85 / 0.7 / 0.5 from PLAN.md 5.1)")
        base = rows[0]
        scale = a.cores * a.e / base["threads"]
        r = dict(base, threads=a.cores, vps=base["vps"] * scale, its=base["its"] * scale, projected=True)
    else:
        r = pick_row(rows, a.threads)
    visits = a.infosets * a.visits_per_infoset
    hours = visits / r["vps"] / 3600
    iters = visits / (r["vps"] / r["its"])
    return r, visits, hours, iters


def rows_base(a):
    return read_bench(a.bench, getattr(a, "trainer", None))[0]["threads"]


def cmd_estimate(a):
    r, visits, hours, iters = run_numbers(a)
    total_h = hours + a.overhead_min / 60
    if r.get("projected"):
        print(f"projected: {a.cores} cores x e={a.e} x the {rows_base(a)}-thread row's per-thread speed "
              f"= {r['vps'] / 1e6:.2f}M visits/s (an estimate, not a measurement)")
    else:
        print(f"bench row: {r['threads']} threads, {r['vps'] / 1e6:.2f}M visits/s, {r['its']:,.0f} it/s")
    print(f"visits = {a.infosets:,} infosets x {a.visits_per_infoset:,} = {visits:.4g}")
    print(f"training wall = {hours:.2f} h; with {a.overhead_min:.0f} min setup/bench/abstraction overhead "
          f"= {total_h:.2f} h")
    print(f"iterations at bench visits/iter = {iters:.4g} (pruning lowers visits/iter, so train.sh "
          "tops up until the visit target is met)")
    if a.price is not None:
        print(f"cost at ${a.price:.4f}/h = ${total_h * a.price:.2f} "
              f"(training only ${hours * a.price:.2f})")
        if a.margin:
            print(f"with a {a.margin:.0%} margin for interruptions and reruns: "
                  f"${total_h * a.price * (1 + a.margin):.2f}  (PLAN.md 5.5 uses 20%)")
    m3_thread_h = visits / (M3_VISITS_PER_THREAD_SEC * 3600)
    print(f"PLAN.md cross-check: M3 thread-hours = {m3_thread_h:.0f} (PLAN.md 5.2 R1: 313)")
    return 0


def cmd_schedule(a):
    r, visits, hours, iters = run_numbers(a)
    total = int(math.ceil(iters))
    discount_every = max(1, int(total * a.lcfr_frac / a.num_discounts))
    lcfr_until = discount_every * a.num_discounts
    prune_after = int(total * a.prune_frac)
    snap_min = max(1.0, hours * 60 / a.snapshots)
    print(f"BENCH_THREADS={r['threads']}")
    print(f"TARGET_VISITS={visits:.0f}")
    print(f"EST_ITERS={total}")
    print(f"EST_HOURS={hours:.3f}")
    print(f"DISCOUNT_EVERY={discount_every}")
    print(f"LCFR_UNTIL={lcfr_until}")
    print(f"PRUNE_AFTER={prune_after}")
    print(f"SNAPSHOT_EVERY_MIN={snap_min:.2f}")
    return 0


def log_visits(path):
    """Cumulative infoset visits from a `bp train` log.csv.

    Each row covers the iterations since the previous row at visits_per_sec /
    iters_per_sec visits per iteration. The iteration counter survives resumes
    (it is in the checkpoint), so Delta-iterations is reliable across restarts. After
    a hard kill the run resumes from an older checkpoint and the iteration count
    goes back; work logged past that point was lost, so it is dropped (linear
    interpolation inside the row that straddles it)."""
    pts = [(0, 0.0)]  # (iteration, cumulative visits)
    last_vpi = None
    with open(path) as fh:
        for r in csv.DictReader(fh):
            it = int(r["iteration"])
            ips, vps = float(r["iters_per_sec"]), float(r["visits_per_sec"])
            if it < pts[-1][0]:
                while len(pts) > 1 and pts[-2][0] >= it:
                    pts.pop()
                (i0, v0), (i1, v1) = pts[-2], pts[-1]
                pts[-1] = (it, v0 + (v1 - v0) * (it - i0) / (i1 - i0) if i1 > i0 else v0)
                continue
            vpi = vps / ips if ips > 0 else (last_vpi or 0.0)
            if ips > 0:
                last_vpi = vpi
            pts.append((it, pts[-1][1] + vpi * (it - pts[-1][0])))
    return pts[-1][0], pts[-1][1], last_vpi


def cmd_visits(a):
    it, v, vpi = log_visits(a.log)
    print(f"ITER={it}")
    print(f"VISITS={v:.0f}")
    print(f"RECENT_VISITS_PER_ITER={vpi or 0:.3f}")
    return 0


def layout_bytes(slots, avg_streets=1, nodes=TREE_NODES):
    """Dense and compact table bytes, the same formulas as src/compact.h
    layout_bytes(): dense 12 B/slot; compact 4 B/slot plus 8 B more on streets
    with a running average, plus 16 B per tree node (block pointer + offset)."""
    total = sum(slots)
    dense = 12 * total
    compact = 4 * total + 8 * sum(slots[:avg_streets]) + 16 * nodes
    return dense, compact


def cmd_memory(a):
    """Table memory per run under both layouts (PLAN.md M3), from measured slot counts."""
    gib = 1e9
    print(f"{'run':<22} {'slots':>15} {'dense 12 B':>11} {'compact':>9} {'ratio':>6} "
          f"{'snapshot file':>13}")
    for name, slots in RUN_SLOTS.items():
        dense, compact = layout_bytes(slots, a.avg_streets)
        accum = 4 * sum(slots) + 40  # bp scale train snapavg.f32 (sparse on preflop)
        print(f"{name:<22} {sum(slots):>15,} {dense / gib:>9.2f} GB {compact / gib:>6.2f} GB "
              f"{compact / dense:>6.3f} {accum / gib:>10.2f} GB")
    print("dense = bp train (GPOCKPT1); compact = bp scale train (GPOCKPT2), all blocks allocated. "
          "Measured on the medium 200 BB tree: lazy allocation reached 98.9% of river node blocks "
          "within 60 s on one thread, so plan RAM for every block.")
    print("A checkpoint is about one table's size; snapshot file = the streaming snapshot average "
          "(4 B per slot, written in place).")
    return 0


def cmd_plan_check(a):
    """Reproduce PLAN.md 5.2 from PLAN.md 5.1's inputs; exits non-zero on mismatch."""
    # PLAN.md 5.1 prices (AWS us-east-1 spot, 2026-10-09) and f/e scenarios.
    c7a, c8g = 3.414, 2.576
    scen = [("optimistic", 1.0, 0.85), ("middle", 0.75, 0.7), ("pessimistic", 0.5, 0.5)]
    # PLAN.md 5.2 table: (run, infosets, thread-h, [(wall h, c7a $, c8g $) per scenario]).
    r2 = 292 * 169 + 6504 * 5000 + 59056 * 5000 + 341224 * 1000  # PLAN.md 5.2 example check
    table = [
        ("R1", PLAN_R1_INFOSETS, 313, [(1.9, 7, 5), (3.1, 11, 8), (6.5, 22, 17)]),
        ("R2", r2, 2575, [(15.8, 54, 41), (25.5, 87, 66), (53.6, 183, 138)]),
    ]
    bad = 0
    for name, inf, th_expect, rows in table:
        visits = inf * VISITS_PER_INFOSET
        th = visits / (M3_VISITS_PER_THREAD_SEC * 3600)
        ok = round(th) == th_expect
        bad += not ok
        print(f"{name}: infosets {inf:,}, M3 thread-h {th:.1f} (PLAN {th_expect}) {'ok' if ok else 'MISMATCH'}")
        for (sname, f, e), (wall_p, c7a_p, c8g_p) in zip(scen, rows):
            core_h = th / f
            wall = core_h / (192 * e)
            got = (round(wall, 1), round(wall * c7a), round(wall * c8g))
            ok = got == (wall_p, c7a_p, c8g_p)
            bad += not ok
            print(f"  {sname:<11} f={f} e={e}: core-h {core_h:,.0f}, wall {wall:.2f} h, "
                  f"c7a ${wall * c7a:.2f}, c8g ${wall * c8g:.2f}  PLAN {wall_p} h ${c7a_p} ${c8g_p} "
                  f"{'ok' if ok else 'MISMATCH'}")
    print("all rows match PLAN.md 5.2" if not bad else f"{bad} mismatches")
    return 1 if bad else 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("--bench", required=True, help="bench.csv from bench.sh")
        sp.add_argument("--threads", type=int, help="bench row to use (default: largest thread count)")
        sp.add_argument("--infosets", type=int, default=R1_INFOSETS)
        sp.add_argument("--visits-per-infoset", type=int, default=VISITS_PER_INFOSET)
        sp.add_argument("--cores", type=int, help="project to this many cores instead of using a bench row")
        sp.add_argument("--e", type=float, help="parallel efficiency for --cores (PLAN.md 5.1: 0.85 / 0.7 / 0.5)")
        sp.add_argument("--trainer", help="compact or dense: rows of a `bp scale bench --dense` CSV")

    s = sub.add_parser("summary")
    s.add_argument("--bench", required=True)
    s.add_argument("--trainer", help="compact or dense: rows of a `bp scale bench --dense` CSV")
    s.add_argument("--ref-vps", type=float, default=M3_VISITS_PER_THREAD_SEC)
    s.set_defaults(fn=cmd_summary)

    s = sub.add_parser("estimate")
    common(s)
    s.add_argument("--price", type=float, help="hourly price in USD, e.g. 3.414 (PLAN.md 5.1, c7a.48xlarge spot)")
    s.add_argument("--overhead-min", type=float, default=0.0,
                   help="minutes of setup, bench and abstraction build to add (measure them)")
    s.add_argument("--margin", type=float, default=0.0, help="e.g. 0.2 for PLAN.md 5.5's 20%% contingency")
    s.set_defaults(fn=cmd_estimate)

    s = sub.add_parser("schedule")
    common(s)
    s.add_argument("--lcfr-frac", type=float, default=LCFR_FRAC)
    s.add_argument("--prune-frac", type=float, default=PRUNE_FRAC)
    s.add_argument("--num-discounts", type=int, default=NUM_DISCOUNTS)
    s.add_argument("--snapshots", type=int, default=8)
    s.set_defaults(fn=cmd_schedule)

    s = sub.add_parser("visits")
    s.add_argument("--log", required=True)
    s.set_defaults(fn=cmd_visits)

    s = sub.add_parser("memory")
    s.add_argument("--avg-streets", type=int, default=1, help="streets with a running average (1 = preflop)")
    s.set_defaults(fn=cmd_memory)

    s = sub.add_parser("plan-check")
    s.set_defaults(fn=cmd_plan_check)

    a = p.parse_args()
    sys.exit(a.fn(a))


if __name__ == "__main__":
    main()
