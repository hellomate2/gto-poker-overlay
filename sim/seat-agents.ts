// ============================================================
// SeatAgent factory: one place that turns an agent spec into a seat, so the
// match runner and the play server can seat things other than DecisionEngine.
//
//   engine (or no spec)   DecisionEngine class passed in by the caller
//   blueprint:<ckpt>      BlueprintAgent over `bp serve` (sim/blueprint-serve.ts)
//
// Agents that hold a child process expose close(); callers close them when
// the match ends.
// ============================================================

import { SeatAgent, SeatView, validateAction } from './ring';
import { makeBotAgent, EngineCtor } from './agents';
import { makeBlueprintSeatAgent } from './blueprint-serve';

export type ClosableSeat = SeatAgent & { close?: () => void; describe?: () => string };

/**
 * Count an engine seat's decisions and the actions the strict validator
 * (sim/ring.ts validateAction) rejects; the ring itself silently normalizes
 * them. When the engine has the BLUEPRINT bridge, report how many decisions it
 * answered and why it passed the others to the normal path.
 */
export function withEngineValidator(seat: SeatAgent): ClosableSeat {
  let decisions = 0, illegal = 0;
  const inner = seat.act.bind(seat);
  const engine = (seat as { engine?: { blueprint?: { stats?: { decisions: number; answered: number; fallbacks: Record<string, number> } } } }).engine;
  return Object.assign(seat, {
    async act(view: SeatView) {
      const r = await inner(view);
      decisions++;
      if (!validateAction(view, { action: r.action, amount: r.toAmount }).ok) illegal++;
      return r;
    },
    describe: () => {
      const bs = engine?.blueprint?.stats;
      const bp = bs && bs.answered > 0
        ? `; blueprint answered ${bs.answered} of ${bs.decisions}, passed on ${JSON.stringify(bs.fallbacks)}`
        : '';
      return `engine: ${decisions} decisions, ${illegal} illegal${bp}`;
    },
  });
}

export async function makeSeatAgent(
  spec: string | undefined, name: string, engineClass: EngineCtor, repoDir: string,
): Promise<ClosableSeat> {
  if (!spec || spec === 'engine') return withEngineValidator(makeBotAgent(name, { engineClass }));
  if (spec.startsWith('blueprint:')) {
    const s = await makeBlueprintSeatAgent(spec, name, repoDir);
    return Object.assign(s, {
      describe: () => {
        const st = s.agent.stats;
        return `blueprint ${s.info.abs} iteration ${s.info.iterations}: ${st.decisions} decisions, ${s.illegal} illegal, ` +
          `${st.fallbacks} fallbacks ${JSON.stringify(st.fallbackReasons)}, ` +
          `${st.translations} opponent raises translated (${st.offTreeTranslations} off-tree)`;
      },
    });
  }
  throw new Error(`unknown agent spec "${spec}" (use engine or blueprint:<ckpt>)`);
}
