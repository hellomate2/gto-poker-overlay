// ============================================================
// In-browser blueprint (src/core/blueprint/web-*.ts, engine-bridge.ts) over the
// committed assets in blueprint/web.
//
// Oracles:
//   - the C++ trainer: tests/fixtures/blueprint-web-parity.jsonl is
//     `bp serve --parity-dump 1000` on the checkpoint the assets were exported
//     from (infosets drawn from the trainer's own deal sampler, 250 per street,
//     with the trainer's node, bucket and float average strategy). Node,
//     bucket and tokens must match exactly; probabilities within the export's
//     quantization (bytes summing to 255, so less than 1/255 per action);
//   - the C++ board isomorphism: the canonical key lists in the assets must
//     equal a fresh colex enumeration (1,755 flops, 16,432 turns, the counts
//     blueprint/tests assert);
//   - suit relabeling leaves every bucket unchanged;
//   - the double-precision river EHS in loader.ts;
//   - the strict action validator (sim/ring.ts validateAction) on every
//     decision of an engine with BLUEPRINT on.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'path';
import '../sim/fake-idb';
import { webParity } from '../sim/blueprint-parity';
import { getWebBlueprint, setWebBlueprintReader, nodeAssetReader } from '../src/core/blueprint/web-assets';
import { WebBlueprint, loadWebBlueprint } from '../src/core/blueprint/web-blueprint';
import { enumerateCanonicalBoards, riverEhsF32, permCard } from '../src/core/blueprint/web-tables';
import { riverEhs } from '../src/core/blueprint/loader';
import { setEngineFlags, resetEngineFlags } from '../src/core/engine-flags';
import { DecisionEngine } from '../src/core/engine';
import { BlueprintBridge } from '../src/core/blueprint/engine-bridge';
import { playRingHand, SeatAgent, makeRng, mixSeed, shuffledDeck, RingConfig } from '../sim/ring';
import { makeBotAgent, makeOpponent, EngineCtor } from '../sim/agents';
import { withEngineValidator } from '../sim/seat-agents';

const FIXTURE = resolve(__dirname, 'fixtures/blueprint-web-parity.jsonl');

let web: WebBlueprint;
beforeAll(async () => {
  web = await loadWebBlueprint(nodeAssetReader(resolve(__dirname, '../blueprint/web'))!);
});

function randomCards(rng: () => number, n: number): number[] {
  const out: number[] = [];
  while (out.length < n) {
    const c = Math.floor(rng() * 52);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

describe('blueprint web assets', () => {
  it('match the trainer on 1,000 sampled infosets (bucket exact, probabilities within 1/255)', async () => {
    const r = await webParity(FIXTURE, resolve(__dirname, '../blueprint/web'), () => {});
    expect(r.n).toBe(1000);
    expect(r.bad).toBe(0);
    expect(r.byStreet).toEqual([250, 250, 250, 250]);
    expect(r.maxDiff).toBeLessThan(1 / 255);
  });

  it('ship the C++ canonical board order', () => {
    const t = web.tables as unknown as { d: { flopKeys: ArrayLike<number>; turnKeys: ArrayLike<number> } };
    const flop = enumerateCanonicalBoards(3);
    const turn = enumerateCanonicalBoards(4);
    expect(flop.length).toBe(1755);
    expect(turn.length).toBe(16432);
    expect(Array.from(t.d.flopKeys)).toEqual(flop);
    expect(Array.from(t.d.turnKeys)).toEqual(turn);
  }, 30_000);

  it('give suit-relabeled hands the same bucket on every street', () => {
    const rng = makeRng(17);
    for (let i = 0; i < 300; i++) {
      const n = [0, 3, 4, 5][i % 4];
      const cards = randomCards(rng, n + 2);
      const hole: [number, number] = [cards[0], cards[1]];
      const board = cards.slice(2);
      const p = Math.floor(rng() * 24);
      const b0 = web.tables.bucket(hole, board);
      const b1 = web.tables.bucket([permCard(hole[1], p), permCard(hole[0], p)], board.map(c => permCard(c, p)).reverse());
      expect(b1).toBe(b0);
      expect(b0).toBeGreaterThanOrEqual(0);
      expect(b0).toBeLessThan(web.blueprint.header.buckets[n === 0 ? 0 : n - 2]);
    }
  });

  it('compute river EHS as the float32 of the exact share', () => {
    const rng = makeRng(5);
    for (let i = 0; i < 40; i++) {
      const c = randomCards(rng, 7);
      const e = riverEhsF32([c[0], c[1]], c.slice(2));
      expect(Math.abs(e - riverEhs([c[0], c[1]], c.slice(2)))).toBeLessThan(1e-6);
      expect(Math.fround(e)).toBe(e);
    }
  });

  it('reject an unknown history and bad cards', () => {
    expect(() => web.source.lookup(['r7'], [0, 1], [])).toThrow();
    expect(() => web.source.lookup([], [0, 0], [])).toThrow();
    expect(() => web.source.lookup(['c', 'k'], [0, 1], [2, 3])).toThrow();
  });
});

// ---- the BLUEPRINT engine flag in the simulator ----------------------------

const CFG: RingConfig = { bb: 20, sb: 10, startStackBB: 100, rng: () => { throw new Error('deck supplied'); } };

async function play(seats: SeatAgent[], hands: number, seed: number): Promise<void> {
  for (let i = 0; i < hands; i++) {
    Math.random = makeRng(mixSeed(seed, i, 1));
    seats.forEach((s, k) => s.reseed?.(mixSeed(seed, i, 100 + k)));
    await playRingHand(seats, i % seats.length, CFG, i + 1, shuffledDeck(makeRng(mixSeed(seed, i))));
  }
}

function engineSeat(name: string) {
  const seat = withEngineValidator(makeBotAgent(name, { engineClass: DecisionEngine as unknown as EngineCtor }));
  const engine = (seat as unknown as { engine: DecisionEngine }).engine;
  return { seat, bridge: engine.blueprint as BlueprintBridge, illegal: () => /(\d+) illegal/.exec(seat.describe!())![1] };
}

describe('BLUEPRINT engine flag', () => {
  const realRandom = Math.random;
  const realLog = console.log;
  beforeAll(() => { setEngineFlags({ BLUEPRINT: true }); console.log = () => {}; });
  afterAll(() => { resetEngineFlags(); Math.random = realRandom; console.log = realLog; setWebBlueprintReader(null); });

  it('plays heads-up from the blueprint with only legal actions', async () => {
    setWebBlueprintReader(null);
    await getWebBlueprint();
    const e = engineSeat('BP');
    await play([e.seat, makeOpponent('lag', 0, 200, 'V')], 60, 3);
    expect(e.bridge.stats.answered).toBeGreaterThan(0);
    expect(e.bridge.stats.answered / e.bridge.stats.decisions).toBeGreaterThan(0.9);
    expect(e.illegal()).toBe('0');
  }, 60_000);

  it('passes multiway hands to the normal engine path', async () => {
    const e = engineSeat('BP');
    await play([e.seat, makeOpponent('tag', 0, 200, 'V1'), makeOpponent('lag', 0, 200, 'V2')], 8, 4);
    expect(e.bridge.stats.answered).toBe(0);
    expect(e.bridge.stats.fallbacks['not heads-up']).toBe(e.bridge.stats.decisions);
    expect(e.illegal()).toBe('0');
  }, 60_000);

  it('falls back to the normal engine path when the assets are missing', async () => {
    setWebBlueprintReader(async () => { throw new Error('missing'); });
    const e = engineSeat('BP');
    await play([e.seat, makeOpponent('tag', 0, 200, 'V')], 8, 5);
    expect(e.bridge.stats.answered).toBe(0);
    expect(e.bridge.stats.fallbacks['assets not loaded']).toBeGreaterThan(0);
    expect(e.bridge.lastLoadError).toMatch(/missing/);
    expect(e.illegal()).toBe('0');
    setWebBlueprintReader(null);
  }, 60_000);
});
