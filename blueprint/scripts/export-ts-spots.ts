// Export river and turn spots solved by the TypeScript range-vs-range solver
// (src/core/solver/postflop-cfr.ts) for the C++ cross-check `bp subgame`.
//
// Usage (from the repo root; esbuild is already a dev dependency):
//   npx esbuild blueprint/scripts/export-ts-spots.ts --bundle --platform=node --outfile=/tmp/ets.js
//   node /tmp/ets.js OUT.txt [N_RIVER] [N_TURN] [ITERS_RIVER] [ITERS_TURN] [SEED]
//
// Each spot: a random board, random ranges (40 to 120 combos per side, random
// weights), random pot / stack / bet facing / position, and the per-street
// default abstraction. The TS solver runs a fixed number of DCFR iterations;
// the file records its exploitability, hero's range value, its wall time and
// the full average strategy at every decision node, so the C++ side can
// (1) score the TS strategy with its own best response and (2) re-solve.
import { writeFileSync } from 'fs';
import { RangeVsRangeCfr, defaultAbstraction, GameNode, RangeHand } from '../../src/core/solver/postflop-cfr';

let state = 0;
function rnd(): number {
  // mulberry32
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function below(n: number): number {
  return Math.floor(rnd() * n);
}

function randomRange(dead: Set<number>, n: number): RangeHand[] {
  const out: RangeHand[] = [];
  const seen = new Set<number>();
  while (out.length < n) {
    const a = below(52);
    const b = below(52);
    if (a === b || dead.has(a) || dead.has(b)) continue;
    const key = Math.min(a, b) * 64 + Math.max(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ cards: [a, b], weight: 0.05 + rnd() });
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const outPath = args[0] ?? 'ts-spots.txt';
  const nRiver = Number(args[1] ?? 10);
  const nTurn = Number(args[2] ?? 10);
  const itRiver = Number(args[3] ?? 300);
  const itTurn = Number(args[4] ?? 200);
  state = Number(args[5] ?? 12345) >>> 0;
  const lines: string[] = [];
  for (let s = 0; s < nRiver + nTurn; s++) {
    const boardLen = s < nRiver ? 5 : 4;
    const board: number[] = [];
    while (board.length < boardLen) {
      const c = below(52);
      if (!board.includes(c)) board.push(c);
    }
    const dead = new Set(board);
    const hero = randomRange(dead, 40 + below(81));
    const villain = randomRange(dead, 40 + below(81));
    const pot = 100 + below(900);
    const spr = 0.5 + rnd() * 5.5;
    const facing = rnd() < 0.4;
    const toCall = facing ? Math.round(pot * (0.25 + rnd()) * 100) / 100 : 0;
    const startingPot = pot - toCall;
    const effectiveStack = Math.round(Math.max(toCall + 1, pot * spr) * 100) / 100;
    const heroIsIP = rnd() < 0.5;
    const prior = facing ? 1 + below(2) : 0;
    const ab = defaultAbstraction(boardLen);
    const tree = { startingPot, effectiveStack, toCall, heroIsIP, priorAggressions: prior, abstraction: ab };
    const cfr = new RangeVsRangeCfr({ board, hero, villain, tree });
    const iters = boardLen === 5 ? itRiver : itTurn;
    const t0 = Date.now();
    for (let i = 0; i < iters; i++) cfr.iterate();
    const ms = Date.now() - t0;
    const expl = cfr.exploitability();
    // hero's range value: sum_i w0[i] * EV_i * mass_i / Z
    const ev = cfr.comboValues(0);
    const w0 = cfr.weights[0];
    const w1 = cfr.weights[1];
    let v0 = 0;
    for (let i = 0; i < hero.length; i++) {
      const [a, b] = hero[i].cards;
      let m = 0;
      for (let j = 0; j < villain.length; j++) {
        const [c, d] = villain[j].cards;
        if (a !== c && a !== d && b !== c && b !== d) m += w1[j];
      }
      if (m > 0) v0 += w0[i] * ev[i] * m;
    }
    v0 /= cfr.jointMass;
    lines.push(`spot ${boardLen === 5 ? 'river' : 'turn'}${s}`);
    lines.push(`board ${board.join(' ')}`);
    lines.push(
      `params ${startingPot} ${effectiveStack} ${toCall} ${heroIsIP ? 1 : 0} ${prior} ${ab.maxAggressions} ${ab.allInMaxSpr} ${ab.allInThreshold}`,
    );
    lines.push(`bet ${ab.betFractions.join(' ')}`);
    lines.push(`raise ${ab.raiseFractions.join(' ')}`);
    for (const [p, r] of [[0, hero], [1, villain]] as [number, RangeHand[]][]) {
      lines.push(`hands ${p} ${r.length}`);
      for (const h of r) lines.push(`${h.cards[0]} ${h.cards[1]} ${h.weight}`);
    }
    lines.push(`ts ${iters} ${expl} ${v0} ${ms}`);
    const stack: GameNode[] = [cfr.root];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.kind !== 'decision') continue;
      const avg = cfr.averageStrategy(n);
      const nh = avg.length / n.actions.length;
      lines.push(`strat ${n.line === '' ? '-' : n.line} ${n.actions.length} ${nh}`);
      lines.push(Array.from(avg).map((x) => String(x)).join(' '));
      for (const c of n.children) stack.push(c);
    }
    lines.push('end');
    process.stderr.write(`spot ${s}: board ${boardLen}, ${hero.length}x${villain.length}, ${iters} it, ${ms} ms, expl ${expl.toFixed(4)}\n`);
  }
  writeFileSync(outPath, lines.join('\n') + '\n');
}

main();
