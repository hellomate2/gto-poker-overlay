# Multi-session coordination

Two Claude Code sessions sometimes work this repo at the same time, sharing one
working tree. To avoid clobbering each other's uncommitted work, we hold to lanes
and a few hard rules.

## Lanes (own only your files)
- **Session A — gameplay execution / live integration:** `src/content-script/**`
  (scraper, executor, bot loop), `src/ui/overlay.ts`, the version badge.
- **Session B — model / study core:** `src/core/ml/**` (`model.ts`, `features.ts`),
  `ml/**` (train/prep/parity), `tests/fixtures/parity-*.json`, the postflop/stake
  decision tests that pin model behavior, `SCORECARD.md`.
- Shared/engine code (`src/core/engine.ts`, ranges, solver) and a release: change
  only by agreement; say so in the commit message.

## Hard rules (these prevent clobbering)
1. **Never** run `git checkout -- <file>`, `git reset`, `git stash`, or `git add -A`
   on files outside your lane. They silently wipe the other session's *uncommitted*
   work. (This already happened once.)
2. `git add` only your specific files by path, then commit. Disjoint-file commits
   coexist fine; the other session's uncommitted changes stay in the tree.
3. Don't build/release while the tree has a known cross-lane mismatch (e.g.
   `features.ts` at one feature count but `model.ts` at another). Build from a clean
   `git worktree` at a committed point if you need a release mid-flux.
4. Commit promptly with a clear message so the other session sees your work via
   `git log`. That log is the communication channel.

## Known invariants (don't "fix" by reverting the other lane)
- A blocker-based bluff-raise of a weak hand (e.g. A7o facing a turn bet) is
  legitimate GTO from the solver-labeled data — not a spew bug. The correct test
  invariant is "never an *illegal* bet facing a bet," not "weak hands never raise."
