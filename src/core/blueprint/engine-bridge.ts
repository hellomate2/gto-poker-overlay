// ============================================================
// BLUEPRINT engine flag: heads-up decisions from the trained blueprint, in
// the browser.
//
// DecisionEngine.decide() calls BlueprintBridge.decide() first when
// ENGINE_FLAGS.BLUEPRINT is on. The bridge returns null, and the engine plays
// its normal path, whenever the blueprint cannot answer exactly:
//   * the table is not heads-up (state.players.length !== 2),
//   * the effective stack at the start of the hand is outside
//     [MIN_STACK_BB, MAX_STACK_BB] (the blueprint was trained at 100 BB; the
//     window is a design choice, not a measured threshold),
//   * the assets did not load (missing file, size mismatch, no reader),
//   * BlueprintAgent fell back (the abstract walk cannot follow the real hand:
//     actor/street/commitment mismatch, an abstract all-in that was called
//     while real chips remain, a policy/tree token mismatch),
//   * anything throws.
// The decision samples the blueprint's average strategy (BlueprintAgent) and
// carries the whole distribution in mixedStrategy, with each abstract bet
// mapped to its real chip amount.
// ============================================================

import { BotDecision, GameState, StrategyDistribution } from '../../types/poker';
import { BlueprintAgent, BlueprintDecision, replayRealHand } from './agent';
import { getWebBlueprint } from './web-assets';

export const MIN_STACK_BB = 50;
export const MAX_STACK_BB = 200;

export interface BridgeStats {
  decisions: number;
  answered: number;
  fallbacks: Record<string, number>;
}

export class BlueprintBridge {
  private agent: BlueprintAgent | null = null;
  readonly stats: BridgeStats = { decisions: 0, answered: 0, fallbacks: {} };
  private loadError: string | null = null;

  /** Start loading the assets (idempotent). */
  preload(): void {
    getWebBlueprint().catch(e => { this.loadError = String(e); });
  }

  private skip(why: string): null {
    this.stats.fallbacks[why] = (this.stats.fallbacks[why] ?? 0) + 1;
    return null;
  }

  async decide(state: GameState): Promise<BotDecision | null> {
    this.stats.decisions++;
    try {
      if (state.players.length !== 2) return this.skip('not heads-up');
      if (!state.heroCards) return this.skip('no hole cards');
      const heroSeat = state.heroIndex === state.dealerIndex ? 0 : 1;
      const real = replayRealHand(state, heroSeat);
      if (!real.ok) return this.skip(`replay: ${real.why}`);
      const bb = state.bigBlind || 1;
      const startStacks = [0, 1].map(seat => {
        const pi = seat === heroSeat ? state.heroIndex : 1 - state.heroIndex;
        return state.players[pi].stack + real.c[seat];
      });
      const eff = Math.min(startStacks[0], startStacks[1]) / bb;
      if (!(eff >= MIN_STACK_BB && eff <= MAX_STACK_BB)) return this.skip('stack depth');
      let web;
      try {
        web = await getWebBlueprint();
      } catch (e) {
        this.loadError = String(e);
        return this.skip('assets not loaded');
      }
      if (!this.agent) {
        // Read Math.random at call time: the simulator swaps it per game.
        this.agent = new BlueprintAgent({ rules: web.rules, source: web.source, rng: () => Math.random() });
      }
      const d = await this.agent.decide(state);
      if (d.fallback !== undefined) return this.skip(`agent: ${d.fallback}`);
      this.stats.answered++;
      return toBotDecision(d, state);
    } catch (e) {
      return this.skip(`error: ${String(e)}`);
    }
  }

  get lastLoadError(): string | null {
    return this.loadError;
  }
}

/** BlueprintDecision -> BotDecision (amounts are street-level raise-to chips). */
export function toBotDecision(d: BlueprintDecision, state: GameState): BotDecision {
  const facingAny = state.currentBet > 0;
  const mixed: StrategyDistribution = { fold: 0, check: 0, call: 0, bets: [] };
  const hero = state.players[state.heroIndex];
  const allinTo = hero.currentBet + hero.stack;
  for (const o of d.options ?? []) {
    if (o.action === 'fold') mixed.fold += o.prob;
    else if (o.action === 'check') mixed.check += o.prob;
    else if (o.action === 'call') mixed.call += o.prob;
    else {
      const amount = o.action === 'allin' ? Infinity : (o.toAmount ?? allinTo);
      const same = mixed.bets.find(b => b.amount === amount);
      if (same) same.probability += o.prob;
      else mixed.bets.push({ amount, probability: o.prob });
    }
  }
  const chosen = d.options?.find(o => o.token === d.token);
  const conf = chosen?.prob ?? 1;
  const reasoning = `blueprint ${d.history?.join(' ') || '(root)'} -> ${d.token} (p=${conf.toFixed(3)})`;
  switch (d.action) {
    case 'fold':
    case 'check':
    case 'call':
      return { action: d.action, amount: undefined, confidence: conf, reasoning, mixedStrategy: mixed };
    case 'allin':
      return { action: 'allin', amount: allinTo, confidence: conf, reasoning, mixedStrategy: mixed };
    default:
      return { action: facingAny ? 'raise' : 'bet', amount: d.toAmount, confidence: conf, reasoning, mixedStrategy: mixed };
  }
}
