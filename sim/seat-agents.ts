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

import { SeatAgent } from './ring';
import { makeBotAgent, EngineCtor } from './agents';
import { makeBlueprintSeatAgent } from './blueprint-serve';

export type ClosableSeat = SeatAgent & { close?: () => void; describe?: () => string };

export async function makeSeatAgent(
  spec: string | undefined, name: string, engineClass: EngineCtor, repoDir: string,
): Promise<ClosableSeat> {
  if (!spec || spec === 'engine') return makeBotAgent(name, { engineClass });
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
