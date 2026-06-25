// ============================================================
// End-to-end smoke test for the self-play simulation harness.
//
// This asserts the HARNESS RUNS and produces well-formed measurements. It does
// NOT assert the bot wins — that would conflate "the sim ran" with "the bot is
// good". The harness is a measurement tool; tests guard its mechanics, not the
// bot's strategy.
// ============================================================

import { describe, it, expect } from 'vitest';
import '../sim/fake-idb';
import { resetFakeIdb } from '../sim/fake-idb';
import { playHand, HUConfig, makeRng, Seat } from '../sim/holdem';
import { makeBotAgent, makeOpponent, archetypeNames } from '../sim/agents';

const BB = 20, SB = 10, START_BB = 100;

describe('sim harness', () => {
  it('all required opponent profiles exist', () => {
    const names = archetypeNames();
    for (const p of ['station', 'nit', 'maniac', 'tag']) {
      expect(names).toContain(p);
    }
  });

  it('runs the real bot end-to-end vs each profile and produces finite, valid measurements (~2k hands)', async () => {
    const HANDS = 2000;
    for (const profile of ['station', 'nit', 'maniac', 'tag']) {
      resetFakeIdb();
      const cfg: HUConfig = { bb: BB, sb: SB, startStackBB: START_BB, rng: makeRng(7) };
      const bot = makeBotAgent('BOT');
      const opp = makeOpponent(profile, 1234);

      let netChips = 0;
      let vpip = 0;
      let sawFlop = 0;
      let wtsd = 0;
      let handsCounted = 0;

      for (let h = 0; h < HANDS; h++) {
        const button: Seat = (h % 2) as Seat;
        const log = await playHand([bot, opp], button, cfg, h + 1);
        handsCounted++;
        netChips += log.net0; // bot is seat 0

        const pf = log.actions.filter((a) => a.seat === 0 && a.street === 'preflop');
        if (pf.some((a) => (a.type === 'call' || a.type === 'raise') && a.voluntary)) vpip++;
        const reachedFlop = log.reachedStreet !== 'preflop' && !pf.some((a) => a.type === 'fold');
        if (reachedFlop) sawFlop++;
        if (log.wentToShowdown) wtsd++;

        // every logged action carries a monotonic order index
        for (let i = 1; i < log.actions.length; i++) {
          expect(log.actions[i].order).toBeGreaterThan(log.actions[i - 1].order);
        }
      }

      expect(handsCounted).toBe(HANDS);

      // bb/100 must be a finite number (NOT asserting sign — the bot may lose).
      const bb100 = (netChips / BB) / HANDS * 100;
      expect(Number.isFinite(bb100)).toBe(true);

      // Frequencies must lie in [0,1].
      const vpipFreq = vpip / HANDS;
      const flopFreq = sawFlop / HANDS;
      const wtsdFreq = wtsd / HANDS;
      for (const f of [vpipFreq, flopFreq, wtsdFreq]) {
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      }

      // Sanity: the bot voluntarily plays SOME hands and folds SOME (it isn't a
      // degenerate always-fold / always-call stub).
      expect(vpip).toBeGreaterThan(0);
      expect(vpip).toBeLessThan(HANDS);

      // WTSD can only happen on hands that reached the flop.
      expect(wtsd).toBeLessThanOrEqual(sawFlop);
    }
  }, 120_000);

  it('reproducible: same seed -> identical bot net', async () => {
    // The bot's mixed strategy + Monte-Carlo equity draw from global Math.random,
    // so full reproducibility requires re-seeding it (the runner does the same via
    // seedGlobalRandom). We seed BOTH Math.random and the deck RNG per run.
    const seedGlobalRandom = (seed: number) => {
      let s = seed >>> 0;
      Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    };
    const realRandom = Math.random;
    const run = async () => {
      seedGlobalRandom(99);
      resetFakeIdb();
      const cfg: HUConfig = { bb: BB, sb: SB, startStackBB: START_BB, rng: makeRng(99) };
      const bot = makeBotAgent('BOT');
      const opp = makeOpponent('tag', 55);
      let net = 0;
      for (let h = 0; h < 300; h++) {
        const log = await playHand([bot, opp], (h % 2) as Seat, cfg, h + 1);
        net += log.net0;
      }
      return net;
    };
    const a = await run();
    const b = await run();
    Math.random = realRandom;
    expect(a).toBe(b);
  }, 60_000);
});
