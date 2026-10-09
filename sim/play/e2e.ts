// ============================================================
// End-to-end check of the play app against the REAL bot over HTTP.
//
// Starts `sim/play/server.ts` as a child process (real DecisionEngine from
// --bot-dir, default this checkout), then plays N hands through the HTTP API
// with a seeded scripted "human" that mixes folds, checks/calls and preset or
// custom raises, and also sends illegal requests that must be refused.
//
// Checks per hand: the bot's hole cards are never in a snapshot before the hand
// ends and appear at the end exactly when the hand went to showdown; chips are
// conserved (your stack + bot stack = starting total); the button alternates;
// every illegal request gets a 4xx and changes nothing. At the end: the
// session's hand count and net match the per-hand results, and the history file
// has one JSONL line per hand with the same nets.
//
//   npm run play:e2e -- [--hands 24] [--seed 5] [--bot-dir PATH] [--flags SPEC] [--port 8791]
//                       [--bot blueprint --policy CKPT]
// Exit code 0 = all checks passed.
// ============================================================

import { spawn, ChildProcess } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { makeRng } from '../ring';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Snap = any;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const hands = Number(args.hands ?? 24);
  const seed = Number(args.seed ?? 5);
  const port = Number(args.port ?? 8791);
  const botDir = resolve(args['bot-dir'] ?? resolve(__dirname, '..', '..'));
  const hist = mkdtempSync(join(tmpdir(), 'play-e2e-'));
  const base = `http://127.0.0.1:${port}`;
  const failures: string[] = [];
  const check = (ok: boolean, msg: string) => { if (!ok) failures.push(msg); };

  const srvArgs = ['tsx', join(__dirname, 'server.ts'), '--port', String(port), '--seed', String(seed),
    '--delay', '0', '--history-dir', hist, '--bot-dir', botDir];
  if (args.flags) srvArgs.push('--flags', args.flags);
  if (args.bot) srvArgs.push('--bot', args.bot);            // e.g. --bot blueprint --policy CKPT
  if (args.policy) srvArgs.push('--policy', resolve(args.policy));
  // Own process group, so stop() takes down npx, tsx and node together.
  const child: ChildProcess = spawn('npx', srvArgs, { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
  let banner = '';
  child.stdout!.on('data', (d) => { banner += d.toString(); });
  const stop = () => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ } };

  try {
    // wait for the server
    for (let i = 0; ; i++) {
      try { const r = await fetch(base + '/api/state'); if (r.ok) break; } catch { /* not up yet */ }
      if (i > 240) throw new Error('server did not start');
      await new Promise(r => setTimeout(r, 250));
    }
    process.stdout.write(banner);

    const get = async (path: string): Promise<Snap> => (await fetch(base + path)).json();
    const post = async (path: string, body: unknown): Promise<{ status: number; body: Snap }> => {
      const r = await fetch(base + path, { method: 'POST', body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const settle = async (s: Snap): Promise<Snap> => {
      while (s.phase === 'bot') s = await get(`/api/state?since=${s.version}&wait=20000`);
      return s;
    };

    const rng = makeRng(seed * 7919 + 1);
    const t0 = Date.now();
    const nets: number[] = [];
    let start: Snap = await get('/api/state');
    const total = start.startStacks.you + start.startStacks.bot;
    let decisions = 0, rejected = 0, showdowns = 0, allIns = 0;

    for (let h = 1; h <= hands; h++) {
      const dealt = await post('/api/deal', {});
      check(dealt.status === 200, `hand ${h}: deal status ${dealt.status}`);
      let s = await settle(dealt.body);
      check(s.hand === h, `hand ${h}: snapshot says hand ${s.hand}`);
      check(s.button === (h % 2 === 1 ? 'you' : 'bot'), `hand ${h}: button ${s.button}`);
      let guard = 0;
      while (s.phase === 'human') {
        if (++guard > 40) throw new Error(`hand ${h} did not end`);
        check(s.bot.hole === null, `hand ${h}: bot hole visible mid-hand`);
        check(s.you.stack + s.bot.stack + s.you.bet + s.bot.bet <= total, `hand ${h}: chips exceed total mid-hand`);
        const L = s.legal;
        // Every few decisions, an illegal request that must be refused.
        if (decisions % 5 === 0) {
          const bad = L.check ? { action: 'fold' } : L.raise ? { action: 'raise', amount: L.raise.minTo - 1 } : { action: 'check' };
          const r = await post('/api/action', bad);
          check(r.status === 400, `hand ${h}: illegal ${JSON.stringify(bad)} got ${r.status}`);
          const again: Snap = await get('/api/state');
          check(again.version === s.version, `hand ${h}: illegal request changed the state`);
          rejected++;
        }
        const u = rng();
        let act: { action: string; amount?: number };
        if (L.fold && u < 0.15) act = { action: 'fold' };
        else if (L.raise && u > 0.7) {
          const ps = L.raise.presets;
          if (u > 0.95) act = { action: 'allin' };
          else if (u > 0.85) act = { action: L.raise.kind, amount: Math.round(L.raise.minTo + (L.raise.maxTo - L.raise.minTo) * rng() * 0.2) };
          else { const p = ps[Math.floor(rng() * ps.length)]; act = p.to === L.raise.maxTo ? { action: 'allin' } : { action: L.raise.kind, amount: p.to }; }
        } else act = { action: L.check ? 'check' : 'call' };
        const r = await post('/api/action', act);
        check(r.status === 200, `hand ${h}: legal ${JSON.stringify(act)} got ${r.status} ${JSON.stringify(r.body.error ?? '')}`);
        decisions++;
        s = await settle(r.body);
      }
      check(s.phase === 'done', `hand ${h}: ended in phase ${s.phase} ${s.error ?? ''}`);
      const res = s.result;
      check(s.you.stack + s.bot.stack === total, `hand ${h}: chips not conserved (${s.you.stack}+${s.bot.stack})`);
      check(res.showdown === (s.bot.hole !== null), `hand ${h}: bot hole shown=${s.bot.hole !== null} but showdown=${res.showdown}`);
      check(Math.abs(s.you.stack - start.startStacks.you - res.net) < 1e-9, `hand ${h}: stack change != net`);
      if (res.showdown) showdowns++;
      if (res.allIn) allIns++;
      nets.push(res.netBb);
      process.stdout.write(`hand ${String(h).padStart(2)}  ${s.button === 'you' ? 'BTN' : 'BB '}  ${res.summary}${res.allIn ? `  [all-in EV ${res.allIn.evNetBb.toFixed(2)} bb]` : ''}\n`);
      start = s;
    }

    const fin: Snap = await get('/api/state');
    const sum = nets.reduce((a, b) => a + b, 0);
    check(fin.session.hands === hands, `session hands ${fin.session.hands} != ${hands}`);
    check(Math.abs(fin.session.net.total - sum) < 1e-9, `session net ${fin.session.net.total} != ${sum}`);
    const files = readdirSync(hist).filter(f => f.endsWith('.jsonl'));
    const lines = files.flatMap(f => readFileSync(join(hist, f), 'utf8').trim().split('\n')).map(l => JSON.parse(l));
    check(lines.length === hands, `history has ${lines.length} lines, expected ${hands}`);
    check(lines.every((l, i) => Math.abs(l.netBb - nets[i]) < 1e-9), 'history nets differ from the API');

    const secs = (Date.now() - t0) / 1000;
    const ss = fin.session;
    const fmt = (r: Snap) => `${r.bb100.toFixed(1)} bb/100 (95% CI +/- ${r.ci95 === null ? 'n/a' : r.ci95.toFixed(1)})`;
    process.stdout.write(`\n${hands} hands, ${decisions} human decisions, ${rejected} illegal requests refused, ${showdowns} showdowns, ${allIns} all-ins, ${secs.toFixed(1)} s\n`);
    process.stdout.write(`scripted human: net ${ss.net.total.toFixed(2)} bb, ${fmt(ss.net)}; all-in adjusted ${fmt(ss.allInAdj)}\n`);
    process.stdout.write(failures.length ? `FAILED (${failures.length}):\n  ${failures.join('\n  ')}\n` : 'E2E OK\n');
    if (failures.length) process.exitCode = 1;
  } finally {
    stop();
    rmSync(hist, { recursive: true, force: true });
  }
}

main().catch((e) => { process.stderr.write(`e2e: ${(e as Error).stack}\n`); process.exit(1); });
