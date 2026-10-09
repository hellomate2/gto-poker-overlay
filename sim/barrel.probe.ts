import { it } from 'vitest';
import { cardToId } from '../src/core/cfr/card-utils';
import { Card, Rank, Suit } from '../src/types/poker';
import { evaluateHand } from '../src/core/equity/hand-eval';
import { villainContinuingRange } from '../src/core/postflop-strategy';
import { leadBetProbability } from '../src/core/cbet';
import { barrelGate, leadPolicyRange, rangeEquities } from '../src/core/defense';

// ============================================================
// BARREL PROBE (diagnostic). Hero c-bet the flop (and the turn, for the river
// row) and villain called. How often does the live lead policy fire again, by
// hero hand class, and how does barrelGate change that once villain's range is
// the range that CALLED (pairs, sets, draws from villainContinuingRange with
// aggression:false) rather than ignored?
//
// Bet probabilities are read straight from leadBetProbability (no sampling).
//   npx vitest run --config sim/vitest.probe.config.ts sim/barrel
// ============================================================

const c = (s: string): Card => ({ rank: s[0] as Rank, suit: s[1] as Suit });
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const BOARDS = [['Js', '9s', '4d', '2h', '2d'], ['Th', '8h', '3c', '2d', '2s'], ['Kd', '7c', '2s', '4h', '9d']];
const N = Number(process.env.PROBE_COMBOS || 150);

it('probe: turn/river barrel frequency vs a range that called', () => {
  const out = (s: string) => process.stdout.write(s + '\n');
  const rng = mulberry32(11);
  const t0 = performance.now();
  out('board\tstreet\tclass\tn\tpolicy bet%\tgated bet%');
  for (const b of BOARDS) for (const street of ['turn', 'river'] as const) {
    const n = street === 'turn' ? 4 : 5;
    const board = b.slice(0, n).map(s => cardToId(c(s)));
    // Pot after 2.5bb open called (100) and half-pot c-bets called on earlier streets.
    const pot = street === 'turn' ? 200 : 400;
    const villain = villainContinuingRange([board[0], board[1]], board, { aggression: false, multiway: false });
    const villainRange = { combos: villain, weights: villain.map(() => 1) };
    const heroRange = leadPolicyRange(board, street, { isAggressor: true, isIP: true, veryWetOrMono: false });
    const dead = new Set(board);
    const live: [number, number][] = [];
    for (let x = 0; x < 52; x++) for (let y = x + 1; y < 52; y++) if (!dead.has(x) && !dead.has(y)) live.push([x, y]);
    for (let i = 0; i < N; i++) { const j = i + Math.floor(rng() * (live.length - i)); [live[i], live[j]] = [live[j], live[i]]; }
    const sample = live.slice(0, N);
    const eqR = rangeEquities(sample, { combos: live, weights: live.map(() => 1) }, board, { runouts: 40 });
    const acc: Record<string, [number, number, number]> = {};
    sample.forEach((hole, i) => {
      const cat = Math.floor(evaluateHand([...hole, ...board]) / 1_000_000);
      const p = leadBetProbability({ isAggressor: true, isIP: true, heroCat: cat, equity: eqR[i], street, veryWetOrMono: false, dangerousFlush: false });
      const bet = Math.round(pot * (street === 'river' ? (cat >= 2 ? 0.9 : cat === 1 ? 0.5 : 0.8) : 0.66));
      const g = p > 0 ? barrelGate({ heroCards: hole, board, villainRange, heroRange, pot, bet, street, baseProbability: p, runouts: 40 }).probability : 0;
      const k = cat === 0 ? 'air/draw' : cat === 1 ? 'one pair' : 'two pair+';
      acc[k] = acc[k] || [0, 0, 0];
      acc[k][0]++; acc[k][1] += p; acc[k][2] += g;
    });
    for (const [k, [cnt, p, g]] of Object.entries(acc)) {
      out(`${b.slice(0, n).join('')}\t${street}\t${k}\t${cnt}\t${Math.round(100 * p / cnt)}%\t${Math.round(100 * g / cnt)}%`);
    }
  }
  out(`probe: ${N} combos/spot, ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}, 3_600_000);
