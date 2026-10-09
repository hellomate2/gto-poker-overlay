import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  Blueprint,
  NODE_DECISION,
  NODE_SHOWDOWN,
  preflopClass,
  riverBucketFromEhs,
  riverEhs,
} from '../src/core/blueprint/loader';

/**
 * The fixtures are real exports from the C++ trainer (blueprint/):
 *   blueprint-kuhn.gpobp    `bp gate --game kuhn --iters 2000000 --export ...`
 *                           (exploitability 0.0011 per the C++ best response)
 *   blueprint-holdem-tiny.gpobp  a short hold'em run on the "tiny" tree with
 *                           an 8/8/8 bucket abstraction (see blueprint/README.md)
 * Kuhn has a closed-form equilibrium family, so the loaded strategy can be
 * checked against theory, which also proves the byte layout round-trips.
 */
const FIX = path.join(__dirname, 'fixtures');
const load = (name: string) =>
  Blueprint.parse(new Uint8Array(fs.readFileSync(path.join(FIX, name))));

// Kuhn cards: bucket 0 = Jack, 1 = Queen, 2 = King.
const J = 0;
const Q = 1;
const K = 2;

describe('blueprint loader: Kuhn export', () => {
  const bp = load('blueprint-kuhn.gpobp');

  it('parses the header and the node table', () => {
    expect(bp.header.game).toBe('kuhn');
    expect(bp.header.buckets).toEqual([3]);
    expect(bp.numNodes).toBe(9);
    expect(bp.header.num_slots).toBe(24);
    const root = bp.node(0);
    expect(root.type).toBe(NODE_DECISION);
    expect(root.player).toBe(0);
    expect(root.contrib).toEqual([1, 1]);
    expect(bp.children(0).map((c) => c.token)).toEqual(['k', 'b']);
    expect(bp.children(bp.findNode(['b'])).map((c) => c.token)).toEqual(['f', 'c']);
  });

  it('round-trips every node through history() and findNode()', () => {
    for (let i = 0; i < bp.numNodes; i++) expect(bp.findNode(bp.history(i))).toBe(i);
    expect(bp.findNode(['x'])).toBe(-1);
    const bc = bp.findNode(['b', 'c']);
    expect(bp.node(bc).type).toBe(NODE_SHOWDOWN);
    expect(bp.node(bc).contrib).toEqual([2, 2]);
  });

  it('returns a strategy close to the analytic Kuhn equilibrium', () => {
    const bet = (h: string[], card: number) => bp.lookup({ history: h, bucket: card })!.probs[1];
    // Player 0 opening: bet J with alpha in [0, 1/3], never Q, K with 3*alpha.
    const alpha = bet([], J);
    expect(alpha).toBeLessThanOrEqual(1 / 3 + 0.03);
    expect(bet([], Q)).toBeLessThan(0.03);
    expect(Math.abs(bet([], K) - 3 * alpha)).toBeLessThan(0.06);
    // Player 1 facing a bet: fold J, call Q 1/3, call K.
    expect(bet(['b'], J)).toBeLessThan(0.03);
    expect(Math.abs(bet(['b'], Q) - 1 / 3)).toBeLessThan(0.05);
    expect(bet(['b'], K)).toBeGreaterThan(0.97);
    // Player 1 after a check: bet J 1/3, check Q, bet K.
    expect(Math.abs(bet(['k'], J) - 1 / 3)).toBeLessThan(0.05);
    expect(bet(['k'], Q)).toBeLessThan(0.03);
    expect(bet(['k'], K)).toBeGreaterThan(0.97);
    // Player 0 after check-bet: fold J, call Q with alpha + 1/3, call K.
    expect(bet(['k', 'b'], J)).toBeLessThan(0.03);
    expect(Math.abs(bet(['k', 'b'], Q) - (alpha + 1 / 3))).toBeLessThan(0.06);
    expect(bet(['k', 'b'], K)).toBeGreaterThan(0.97);
  });

  it('exposes lookups by key and validates inputs', () => {
    const key = Blueprint.infosetKey({ history: ['k'], bucket: K });
    expect(key).toBe('k|2');
    const r = bp.lookupKey(key)!;
    expect(r.actions).toEqual(['k', 'b']);
    expect(r.player).toBe(1);
    expect(r.visited).toBe(true);
    expect(r.probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(bp.lookupKey('|0')!.node).toBe(0);
    expect(bp.lookup({ history: ['b', 'c'], bucket: 0 })).toBeNull(); // terminal
    expect(() => bp.strategyAt(0, 3)).toThrow(RangeError);
  });

  it('treats an all-zero (never trained) infoset as uniform', () => {
    const raw = new Uint8Array(fs.readFileSync(path.join(FIX, 'blueprint-kuhn.gpobp')));
    const copy = Blueprint.parse(raw);
    const off = copy.header.strategy_offset + copy.node(0).strategyOffset + Q * 2;
    raw[off] = 0;
    raw[off + 1] = 0;
    const s = Blueprint.parse(raw).strategyAt(0, Q);
    expect(s.visited).toBe(false);
    expect(s.probs).toEqual([0.5, 0.5]);
  });

  it('rejects malformed files', () => {
    const raw = new Uint8Array(fs.readFileSync(path.join(FIX, 'blueprint-kuhn.gpobp')));
    const bad = raw.slice();
    bad[0] = 0x58;
    expect(() => Blueprint.parse(bad)).toThrow(/magic/);
    expect(() => Blueprint.parse(raw.slice(0, raw.length - 1))).toThrow(/truncated/);
    expect(() => Blueprint.parse(raw.slice(0, 20))).toThrow(/truncated/);
  });
});

describe("blueprint loader: hold'em export", () => {
  const bp = load('blueprint-holdem-tiny.gpobp');

  it('navigates the no-limit tree with pot-fraction tokens', () => {
    expect(bp.header.game).toBe('holdem-tiny');
    expect(bp.header.buckets[0]).toBe(169);
    const root = bp.node(0);
    expect(root.player).toBe(0);
    expect(root.contrib).toEqual([50, 100]);
    expect(bp.children(0).map((c) => c.token)).toEqual(['f', 'c', 'r1', 'a']);
    // SB pot-raise: call 50 -> pot 200 -> raise 200 more -> 300 total
    expect(bp.node(bp.findNode(['r1'])).contrib).toEqual([300, 100]);
    // limp + check reaches the flop with the big blind first to act
    const flop = bp.node(bp.findNode(['c', 'k']));
    expect(flop.street).toBe(1);
    expect(flop.player).toBe(1);
    expect(bp.children(flop.index).map((c) => c.token)).toEqual(['k', 'b0.75', 'a']);
    for (let i = 0; i < bp.numNodes; i += 97) expect(bp.findNode(bp.history(i))).toBe(i);
  });

  it('plays sensible preflop extremes after training', () => {
    const open = (a: number, b: number) => bp.lookup({ history: [], bucket: preflopClass(a, b) })!;
    // card id = rank * 4 + suit; aces are rank 12, deuces rank 0
    const aa = open(12 * 4 + 0, 12 * 4 + 1);
    const sevenTwo = open(5 * 4 + 0, 0 * 4 + 1);
    expect(aa.visited).toBe(true);
    expect(aa.probs[0]).toBeLessThan(0.02); // never fold aces
    expect(sevenTwo.probs[0]).toBeGreaterThan(aa.probs[0]);
  });

  it('maps river EHS with the exported bounds', () => {
    const bounds = bp.header.abstraction!.river_bounds!;
    expect(bounds.length).toBe(bp.header.buckets[3] - 1);
    expect(bp.riverBucket(0)).toBe(0);
    expect(bp.riverBucket(1)).toBe(bounds.length);
  });
});

describe('preflopClass / riverBucketFromEhs', () => {
  it('covers 169 classes with 6/4/12 combos', () => {
    const counts = new Array(169).fill(0);
    for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) counts[preflopClass(a, b)]++;
    let pairs = 0;
    let suited = 0;
    let off = 0;
    for (let i = 0; i < 169; i++) {
      const r = Math.floor(i / 13);
      const c = i % 13;
      if (r === c) {
        expect(counts[i]).toBe(6);
        pairs++;
      } else if (r > c) {
        expect(counts[i]).toBe(4);
        suited++;
      } else {
        expect(counts[i]).toBe(12);
        off++;
      }
    }
    expect([pairs, suited, off]).toEqual([13, 78, 78]);
    expect(preflopClass(48, 49)).toBe(168); // AA
    expect(preflopClass(48, 44)).toBe(12 * 13 + 11); // AKs (same suit)
    expect(preflopClass(20, 1)).toBe(0 * 13 + 5); // 72o
  });

  it("computes river EHS with the trainer's definition", () => {
    // card id = rank * 4 + suit (suits h d c s)
    const royal = [12 * 4, 11 * 4, 10 * 4, 9 * 4, 8 * 4]; // AhKhQhJhTh: everyone ties
    expect(riverEhs([0, 1], royal)).toBe(0.5);
    // quad aces with the case king: only the other kings... nobody beats it
    const board = [12 * 4, 12 * 4 + 1, 12 * 4 + 2, 3 * 4, 7 * 4 + 1];
    expect(riverEhs([12 * 4 + 3, 11 * 4], board)).toBe(1);
    expect(() => riverEhs([0, 0], royal)).toThrow();
  });

  it('matches std::upper_bound semantics', () => {
    const b = [0.2, 0.5, 0.8];
    expect(riverBucketFromEhs(0.1, b)).toBe(0);
    expect(riverBucketFromEhs(0.2, b)).toBe(1); // equal to a bound goes up
    expect(riverBucketFromEhs(0.79, b)).toBe(2);
    expect(riverBucketFromEhs(0.95, b)).toBe(3);
  });
});
