// ============================================================
// Bot registry for the play server.
//
// A bot is anything that yields a SeatAgent (sim/ring.ts): the play session
// only calls agent.act(view) and, if present, agent.observe(finalState). To add
// a new kind of opponent, write a BotFactory and register it in BOT_FACTORIES;
// the server picks it with --bot <kind>. Nothing else changes.
//
// Kinds today:
//   engine     DecisionEngine from any checkout (--bot-dir, default this
//              worktree), loaded with sim/match.ts loadEngine so the checkout
//              keeps its own module graph. Engine feature flags pass through
//              GPO_ENGINE_FLAGS (set it in the environment or with --flags);
//              checkouts without src/core/engine-flags.ts ignore it.
//
// Planned (not built yet):
//   blueprint  BlueprintAgent over the C++ trainer's exported policy
//              (blueprint/ on ws/blueprint, TS loader in
//              src/core/blueprint/loader.ts). Register it as
//                BOT_FACTORIES.blueprint = async (o) => ({
//                  info: { kind: 'blueprint', label: ..., dir: o.dir },
//                  agent: makeBlueprintAgent(o.policyFile),
//                });
//              where makeBlueprintAgent maps SeatView to the abstraction,
//              samples the policy and returns an ActResult.
// ============================================================

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { SeatAgent } from '../ring';
import { loadEngine } from '../match';
import { makeBotAgent } from '../agents';

export interface BotOptions {
  /** Source checkout for kinds that load code from a tree. */
  dir: string;
  /** Engine flag spec (GPO_ENGINE_FLAGS syntax). undefined = leave env as is. */
  flags?: string;
  /** Let the engine track the human across hands (exploit adjuster). */
  exploit?: boolean;
  /** Path to a policy file, for future policy-based kinds. */
  policyFile?: string;
}

export interface BotInfo {
  kind: string;
  label: string;
  dir?: string;
  commit?: string;
  /** Active engine flags as the engine reports them, or a note. */
  flags?: string;
  exploit?: boolean;
}

export interface PlayBot { info: BotInfo; agent: SeatAgent }

export type BotFactory = (opts: BotOptions) => Promise<PlayBot>;

export function gitDescribe(dir: string): string {
  try {
    const sha = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
    return `${branch}@${sha}${dirty ? '+dirty' : ''}`;
  } catch { return 'not a git checkout'; }
}

/** Ask the loaded checkout which flags are on (same module instance the engine uses). */
async function describeFlags(dir: string): Promise<string> {
  const file = resolve(dir, 'src/core/engine-flags.ts');
  if (!existsSync(file)) return 'none (this checkout has no engine flags)';
  try {
    const mod = await import(pathToFileURL(file).href);
    const fn = mod.describeEngineFlags ?? mod.default?.describeEngineFlags;
    return typeof fn === 'function' ? String(fn()) : 'unknown';
  } catch (e) { return `unreadable (${(e as Error).message})`; }
}

const engineBot: BotFactory = async (opts) => {
  // The engine reads GPO_ENGINE_FLAGS when its flag module is first imported,
  // so the variable has to be set before loadEngine.
  if (opts.flags !== undefined) process.env.GPO_ENGINE_FLAGS = opts.flags;
  const Ctor = await loadEngine(opts.dir);
  const agent = makeBotAgent('Bot', { engineClass: Ctor, exploit: !!opts.exploit });
  const commit = gitDescribe(opts.dir);
  return {
    info: {
      kind: 'engine', label: `DecisionEngine ${commit}`, dir: opts.dir, commit,
      flags: await describeFlags(opts.dir), exploit: !!opts.exploit,
    },
    agent,
  };
};

export const BOT_FACTORIES: Record<string, BotFactory> = {
  engine: engineBot,
};

export async function makePlayBot(kind: string, opts: BotOptions): Promise<PlayBot> {
  const f = BOT_FACTORIES[kind];
  if (!f) throw new Error(`unknown bot kind "${kind}" (known: ${Object.keys(BOT_FACTORIES).join(', ')})`);
  return f(opts);
}
