import { it } from 'vitest';
import { cardToId } from '../src/core/cfr/card-utils';
import { Card, Rank, Suit } from '../src/types/poker';
import { villainContinuingRange } from '../src/core/postflop-strategy';
import { defendVsAggression, balancedAggressorRange, leadPolicyRange } from '../src/core/defense';

// Latency of the defense pipeline per street (range build + defendVsAggression),
// the work the engine would add to every facing-a-bet postflop decision.
//   npx vitest run --config sim/vitest.probe.config.ts sim/defense-latency
const c = (s: string): Card => ({ rank: s[0] as Rank, suit: s[1] as Suit });
it('defense latency', () => {
  const full = ['Js', '9s', '4d', '2h', '7c'].map(s => cardToId(c(s)));
  const hero: [number, number] = [cardToId(c('Ah')), cardToId(c('Jd'))];
  for (const n of [3, 4, 5]) {
    const board = full.slice(0, n);
    const street = n === 3 ? 'flop' : n === 4 ? 'turn' : 'river';
    const reps = 10;
    let tRange = 0, tDef = 0, hn = 0, vn = 0;
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      const value = villainContinuingRange([board[0], board[1]], board, { aggression: true, multiway: false });
      const vr = balancedAggressorRange(value, board, street, 1.2);
      const hr = leadPolicyRange(board, street, { isAggressor: true, isIP: true, veryWetOrMono: false });
      const t1 = performance.now();
      defendVsAggression({ heroCards: hero, board, heroRange: hr, villainRange: vr, pot: 500, toCall: 200, street, villainActionSizeFrac: 1.2, facingRaise: true });
      const t2 = performance.now();
      tRange += t1 - t0; tDef += t2 - t1; hn = hr.combos.length; vn = vr.combos.length;
    }
    process.stdout.write(`${street}: ranges ${(tRange / reps).toFixed(1)} ms + defendVsAggression ${(tDef / reps).toFixed(1)} ms (hero ${hn} combos, villain ${vn} combos, mean of ${reps})\n`);
  }
});
