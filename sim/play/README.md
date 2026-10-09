# Play heads-up vs the bot

1. `npm run play` (from the repo root; add `-- --bot-dir ~/Downloads/gpo-wt/integrate --flags all` to play another checkout's engine with its flags).
2. Open http://127.0.0.1:8765/ and press N to deal.
3. Act with F (fold), C (check/call), R (bet/raise at the selected size), 1 to 6 for size presets, or type a raise-to amount in bb.

Everything runs on localhost; no poker site is involved.

## Options

```
npm run play -- [--port 8765] [--bot engine] [--bot-dir PATH] [--flags SPEC]
                [--sb 10] [--bb 20] [--stack-bb 100] [--you-bb N] [--bot-bb N]
                [--delay 600] [--seed N] [--exploit] [--no-history | --history-dir DIR]
```

- `--bot` picks the opponent kind: `engine` (default), `blueprint` (the C++ blueprint's average policy over `bp serve`, needs `--policy CKPT` and `GPO_BP_FLAGS`), or `blueprint+search` (the same plus real-time search at its river decisions, 1.5 s per decision; see blueprint/README.md, "Blueprint plus real-time search in the agent"). Example: `GPO_BP_FLAGS="--preset small --flop 200 --turn 200 --river 200 --bins 50 --abs-seed 7 --cache /Users/rg/.gpo/overnight/cache" npm run play -- --bot blueprint+search --policy /Users/rg/.gpo/eval/final.bin`.
- `--bot-dir` loads `src/core/engine.ts` from any checkout (default: this one), the same way `sim/match.ts` does.
- `--flags` sets `GPO_ENGINE_FLAGS` before the engine loads (`all`, `none`, `DEFENSE,RANGE_TRACKER`, `+DEFENSE`). Setting the environment variable yourself works too. Checkouts without `src/core/engine-flags.ts` ignore it.
- `--exploit` lets the bot track you across hands (its profiler and exploit adjuster). Off by default, which matches the harness baseline.
- `--delay` is the minimum time a bot decision takes, in ms.
- `--seed` makes the deals reproducible. Each hand's deck seed and `Math.random` seed are in the history.
- Stacks reset every hand (the harness's cash model), and the button alternates, starting with you.

## What the session panel shows

- bb/100 for you, with a 95% Student-t interval on per-hand results. Results per hand are heavy-tailed, so read the interval as rough until a few hundred hands.
- All-in adjusted bb/100: when the money goes in before the river, the realized result of that hand is replaced by its expectation over every remaining run-out (exact enumeration, `allin-ev.ts`). Run-out luck is the realized total minus the adjusted total.

## Files

- `server.ts`: HTTP server and CLI. `session.ts`: one session, built on `playRingHand` from `sim/ring.ts`, with your seat as an agent that waits for the API. Your actions are checked by `validateAction` in `sim/ring.ts`, which shares its raise bounds with the engine's own betting loop.
- `bots.ts`: the bot registry. A future BlueprintAgent registers there as a new kind (see the comment at the top).
- `history/<date>.jsonl`: one line per hand (cards, actions, nets, all-in EV). Git-ignored.
- `e2e.ts` (`npm run play:e2e`): starts the server with the real engine and plays scripted hands through the HTTP API, checking chip conservation, hidden cards, refused illegal actions and the history file. Unit tests are in `tests/sim-play.test.ts`.

## HTTP API

- `GET /api/state[?since=V&wait=MS]`: snapshot; with `wait` it long-polls until the version passes V and the bot is not thinking.
- `POST /api/deal`: start the next hand.
- `POST /api/action` with `{"action": "fold|check|call|bet|raise|allin", "amount": <raise-to in chips>}`. Illegal requests get status 400 and change nothing; acting out of turn gets 409.
