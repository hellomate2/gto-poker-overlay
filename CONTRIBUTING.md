# Contributing

Thanks for taking a look. This is a TypeScript Chrome extension plus a poker
game-theory toolkit.

## Setup
```bash
npm install
npm run build      # production build -> dist/
npm run dev        # webpack watch mode
npm test           # vitest suite (200+ tests)
```
Load the extension with `chrome://extensions` -> Developer mode -> Load unpacked -> `dist/`.

## Regenerating solved data
Some files under `src/core/ranges/` and `src/core/ml/` are generated and marked
`linguist-generated` in `.gitattributes`. To regenerate:
```bash
npm run solve:equity    # 169x169 preflop all-in equity matrix (cached)
npm run solve:preflop   # heads-up preflop CFR equilibrium -> headsup-solved.ts
npm run ml:prep         # build ML feature/label tensors from ml/data
npm run ml:train        # train the postflop policy net -> src/core/ml/model.ts
```

## Conventions
- TypeScript strict. Prefer explicit types over `any`.
- Use `src/core/logger.ts` (`log.*`) instead of `console.*`.
- Keep PokerNow DOM selectors in the shared selector module.
- Add or update tests for any logic change. Solver/equity changes must keep the
  correctness tests (exhaustive evaluator distribution, CFR convergence) green.
- Commit messages: terse and descriptive.

## Honesty bar
Claims in the README/docs must be backed by code and tests. The project is an
approximation, not a perfect solver — keep statements accurate.
