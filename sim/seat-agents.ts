// ============================================================
// SeatAgent factory: one place that turns an agent spec into a seat, so the
// match runner and the play server can seat things other than DecisionEngine.
//
//   engine (or no spec)   DecisionEngine class passed in by the caller
//   blueprint:<ckpt>      BlueprintAgent over `bp serve` (sim/blueprint-serve.ts)
//   blueprint+search:<ckpt>  the same with real-time river search (GPO_BP_SEARCH
//                         = turn+river adds the turn; see sim/blueprint-serve.ts)
//
// Agents that hold a child process expose close(); callers close them when
// the match ends.
// ============================================================

import { SeatAgent } from './ring';
import { makeBotAgent, EngineCtor } from './agents';
import { makeBlueprintSeatAgent, percentile } from './blueprint-serve';

export type ClosableSeat = SeatAgent & { close?: () => void; describe?: () => string };

export async function makeSeatAgent(
  spec: string | undefined, name: string, engineClass: EngineCtor, repoDir: string,
): Promise<ClosableSeat> {
  if (!spec || spec === 'engine') return makeBotAgent(name, { engineClass });
  if (spec.startsWith('blueprint:') || spec.startsWith('blueprint+search:')) {
    const s = await makeBlueprintSeatAgent(spec, name, repoDir);
    return Object.assign(s, {
      describe: () => {
        const st = s.agent.stats;
        let txt = `blueprint ${s.info.abs} iteration ${s.info.iterations}: ${st.decisions} decisions, ${s.illegal} illegal, ` +
          `${st.fallbacks} fallbacks ${JSON.stringify(st.fallbackReasons)}, ` +
          `${st.translations} opponent raises translated (${st.offTreeTranslations} off-tree)`;
        if (s.agent.searchMode !== 'off') {
          const ss = s.agent.searchStats;
          txt += `; search ${s.agent.searchMode}: ${ss.attempts} attempts, ${ss.searched} searched ` +
            `(${ss.offTree} with an off-tree size), ${ss.fallbacks} fallbacks ${JSON.stringify(ss.fallbackReasons)}, ` +
            `round trip ms p50 ${percentile(ss.ms, 50)} p95 ${percentile(ss.ms, 95)} max ${ss.ms.length ? Math.max(...ss.ms) : NaN}, ` +
            `iterations p50 ${percentile(ss.iters, 50)}`;
        }
        return txt;
      },
    });
  }
  throw new Error(`unknown agent spec "${spec}" (use engine, blueprint:<ckpt> or blueprint+search:<ckpt>)`);
}
