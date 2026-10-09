// ============================================================
// Test helper: build WeightedRange objects from compact hand notation.
//   'AA'      every pocket-pair combo
//   'AKs'     suited combos, 'AKo' offsuit combos, 'AK' both
//   'AhKh'    one explicit combo
//   'AK:0.3'  any of the above with a relative weight (default 1)
// Combos touching `dead` cards (board) are skipped. Duplicates keep the last
// weight given.
// ============================================================

import { CardId } from '../../src/types/poker';
import { WeightedRange } from '../../src/core/ranges/weighted-range';
import { cid } from '../helpers';

const RANKS = '23456789TJQKA';
const SUITS = 'hdcs';

export function rangeOf(spec: string[], dead: CardId[] = []): WeightedRange {
  const blocked = new Set(dead);
  const map = new Map<number, { combo: [CardId, CardId]; w: number }>();
  const add = (a: CardId, b: CardId, w: number) => {
    if (a === b || blocked.has(a) || blocked.has(b)) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    map.set(lo * 64 + hi, { combo: [lo, hi], w });
  };
  for (const item of spec) {
    const [hand, wStr] = item.split(':');
    const w = wStr ? Number(wStr) : 1;
    if (hand.length === 4) {
      add(cid(hand.slice(0, 2)), cid(hand.slice(2)), w);
      continue;
    }
    const r1 = hand[0];
    const r2 = hand[1];
    const kind = hand[2] ?? '';
    for (const s1 of SUITS) {
      for (const s2 of SUITS) {
        if (r1 === r2 && SUITS.indexOf(s2) <= SUITS.indexOf(s1)) continue;
        if (kind === 's' && s1 !== s2) continue;
        if (kind === 'o' && s1 === s2) continue;
        if (!RANKS.includes(r1) || !RANKS.includes(r2)) throw new Error(`bad hand ${hand}`);
        add(cid(r1 + s1), cid(r2 + s2), w);
      }
    }
  }
  const combos: [CardId, CardId][] = [];
  const weights: number[] = [];
  for (const { combo, w } of map.values()) {
    combos.push(combo);
    weights.push(w);
  }
  return { combos, weights };
}

/** Total probability on bet/raise/all-in labels in a label->prob strategy. */
export function aggressionMass(strategy: Record<string, number>): number {
  let s = 0;
  for (const [k, p] of Object.entries(strategy)) if (k[0] === 'B' || k[0] === 'R' || k === 'A') s += p;
  return s;
}
