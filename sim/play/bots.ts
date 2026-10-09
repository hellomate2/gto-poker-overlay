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
//   blueprint  BlueprintAgent (src/core/blueprint/agent.ts) over a C++
//              trainer checkpoint served by `bp serve` (--policy CKPT; tree
//              and abstraction flags from GPO_BP_FLAGS, binary from
//              GPO_BP_BIN or <bot-dir>/blueprint/bin/bp). Heads-up, trained
//              at 100 BB; average policy, no search. See sim/blueprint-serve.ts.
//
//   blueprint+search
//              the same agent with real-time search at its river decisions
//              (`bp serve` "search", 1.5 s budget, blueprint fallback on
//              timeout or error; GPO_BP_SEARCH=turn+river adds the turn).
//              `npm run play -- --bot blueprint+search --policy CKPT`
// ============================================================

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { SeatAgent } from '../ring';
import { loadEngine } from '../match';
import { makeBotAgent } from '../agents';
import { makeBlueprintSeatAgent, DEFAULT_BP_FLAGS } from '../blueprint-serve';

export interface BotOptions {
  /** Source checkout for kinds that load code from a tree. */
  dir: string;
  /** Engine flag spec (GPO_ENGINE_FLAGS syntax). undefined = leave env as is. */
  flags?: string;
  /** Let the engine track the human across hands (exploit adjuster). */
  exploit?: boolean;
  /** Policy file for policy-based kinds (blueprint: a bp checkpoint). */
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

const blueprintBot: BotFactory = async (opts) => {
  if (!opts.policyFile) throw new Error('--bot blueprint needs --policy <checkpoint>');
  const seat = await makeBlueprintSeatAgent(`blueprint:${opts.policyFile}`, 'Bot', opts.dir);
  return {
    info: {
      kind: 'blueprint',
      label: `Blueprint ${seat.info.abs}, iteration ${seat.info.iterations} (no search)`,
      dir: opts.dir, commit: gitDescribe(opts.dir),
      flags: (process.env.GPO_BP_FLAGS ?? DEFAULT_BP_FLAGS),
    },
    agent: seat,
  };
};

const blueprintSearchBot: BotFactory = async (opts) => {
  if (!opts.policyFile) throw new Error('--bot blueprint+search needs --policy <checkpoint>');
  const seat = await makeBlueprintSeatAgent(`blueprint+search:${opts.policyFile}`, 'Bot', opts.dir);
  const budget = process.env.GPO_BP_SEARCH_MS ?? '1500';
  return {
    info: {
      kind: 'blueprint+search',
      label: `Blueprint ${seat.info.abs}, iteration ${seat.info.iterations} + ${seat.agent.searchMode} search (${budget} ms)`,
      dir: opts.dir, commit: gitDescribe(opts.dir),
      flags: (process.env.GPO_BP_FLAGS ?? DEFAULT_BP_FLAGS),
    },
    agent: seat,
  };
};

export const BOT_FACTORIES: Record<string, BotFactory> = {
  engine: engineBot,
  blueprint: blueprintBot,
  'blueprint+search': blueprintSearchBot,
};

export async function makePlayBot(kind: string, opts: BotOptions): Promise<PlayBot> {
  const f = BOT_FACTORIES[kind];
  if (!f) throw new Error(`unknown bot kind "${kind}" (known: ${Object.keys(BOT_FACTORIES).join(', ')})`);
  return f(opts);
}
