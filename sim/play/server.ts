// ============================================================
// Local play server: heads-up No-Limit Hold'em, you vs the bot, on localhost.
// No poker site is involved; the page and the API are served from 127.0.0.1.
//
//   npm run play -- [--port 8765] [--bot engine] [--bot-dir PATH] [--flags SPEC]
//                   [--sb 10] [--bb 20] [--stack-bb 100] [--you-bb N] [--bot-bb N]
//                   [--delay 600] [--seed N] [--exploit] [--no-history]
//                   [--history-dir DIR] [--policy CKPT (with --bot blueprint or blueprint+search)]
//
// API (JSON):
//   GET  /api/state[?since=V&wait=MS]  snapshot; with wait, long-polls until the
//                                      version passes V and the bot is not thinking
//   POST /api/deal                     start the next hand
//   POST /api/action {action, amount}  action: fold|check|call|bet|raise|allin,
//                                      amount = raise-TO in chips for bet/raise
// Errors come back as {error} with status 400 (illegal) or 409 (wrong phase).
// ============================================================

import '../fake-idb';
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { PlaySession, PlayError, SessionConfig } from './session';
import { makePlayBot, BOT_FACTORIES } from './bots';

const PAGE = join(__dirname, 'index.html');

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((ok, fail) => {
    let buf = '';
    req.on('data', (d) => {
      buf += d;
      if (buf.length > 10_000) { fail(new PlayError('body too large', 413)); req.destroy(); }
    });
    req.on('end', () => {
      if (!buf.trim()) return ok({});
      try { ok(JSON.parse(buf)); } catch { fail(new PlayError('body is not JSON')); }
    });
    req.on('error', fail);
  });
}

/** Let the engine run its synchronous follow-up (the next act() call) before we snapshot. */
const tick = () => new Promise<void>(r => setImmediate(r));

export function makeHandler(session: PlaySession) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(readFileSync(PAGE, 'utf8'));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const wait = Math.min(30_000, Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0));
        const since = Number(url.searchParams.get('since') ?? -1);
        if (wait > 0) await session.waitFor(Number.isFinite(since) ? since : -1, wait);
        return send(res, 200, session.snapshot());
      }
      if (req.method === 'POST' && url.pathname === '/api/deal') {
        session.deal();
        await tick();
        return send(res, 200, session.snapshot());
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        const body = await readBody(req) as { action?: unknown; amount?: unknown };
        if (typeof body.action !== 'string') throw new PlayError('missing "action"');
        const amount = body.amount === undefined || body.amount === null ? undefined : Number(body.amount);
        session.act({ action: body.action, amount });
        await tick();
        return send(res, 200, session.snapshot());
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof PlayError) return send(res, e.status, { error: e.message });
      send(res, 500, { error: (e as Error).message });
    }
  };
}

export function startServer(session: PlaySession, port: number, host = '127.0.0.1'): Promise<Server> {
  const handler = makeHandler(session);
  const server = createServer((req, res) => { void handler(req, res); });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => ok(server));
  });
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
    else out[a.slice(2)] = true;
  }
  return out;
}

function num(args: Record<string, string | true>, key: string, def: number): number {
  const v = args[key];
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number`);
  return n;
}

export async function main(argv = process.argv.slice(2)): Promise<{ server: Server; session: PlaySession }> {
  const args = parseArgs(argv);
  const out = (s: string) => process.stdout.write(s + '\n');
  if (args.help) {
    out('npm run play -- [--port 8765] [--bot engine] [--bot-dir PATH] [--flags SPEC] [--sb 10] [--bb 20]');
    out('                [--stack-bb 100] [--you-bb N] [--bot-bb N] [--delay 600] [--seed N] [--exploit]');
    out('                [--no-history | --history-dir DIR]');
    out(`bot kinds: ${Object.keys(BOT_FACTORIES).join(', ')}`);
    process.exit(0);
  }
  const sb = num(args, 'sb', 10), bb = num(args, 'bb', 20);
  if (!(sb > 0 && bb >= sb && Number.isInteger(sb) && Number.isInteger(bb))) throw new Error('blinds must be whole chips with 0 < sb <= bb');
  const stackBb = num(args, 'stack-bb', 100);
  const youBb = num(args, 'you-bb', stackBb), botBb = num(args, 'bot-bb', stackBb);
  if (!(youBb >= 1 && botBb >= 1)) throw new Error('stacks must be at least 1 bb');
  const repoRoot = resolve(__dirname, '..', '..');
  const dir = resolve(String(args['bot-dir'] ?? repoRoot));
  const kind = String(args.bot ?? 'engine');
  const flags = typeof args.flags === 'string' ? args.flags : undefined;

  console.log = () => {}; // the engine logs every decision; the server writes to stdout directly
  const policyFile = typeof args.policy === 'string' ? resolve(args.policy) : undefined;  // --bot blueprint
  const playBot = await makePlayBot(kind, { dir, flags, exploit: args.exploit === true, policyFile });

  const cfg: SessionConfig = {
    sb, bb,
    humanStack: Math.round(youBb * bb), botStack: Math.round(botBb * bb),
    seed: args.seed !== undefined ? num(args, 'seed', 1) >>> 0 : (Date.now() >>> 0),
    botDelayMs: num(args, 'delay', 600),
    historyDir: args['no-history'] === true ? null
      : typeof args['history-dir'] === 'string' ? resolve(args['history-dir']) : join(__dirname, 'history'),
  };
  const session = new PlaySession(cfg, playBot.agent, playBot.info);
  const port = num(args, 'port', 8765);
  const server = await startServer(session, port);
  out(`play: http://127.0.0.1:${port}/`);
  out(`bot:  ${playBot.info.label}  dir=${playBot.info.dir ?? '-'}  flags=${playBot.info.flags ?? '-'}${playBot.info.exploit ? '  exploit=on' : ''}`);
  out(`game: blinds ${sb}/${bb}, stacks you ${cfg.humanStack} / bot ${cfg.botStack} chips, seed ${cfg.seed}`);
  out(`hands are logged to ${cfg.historyDir ?? '(disabled)'}`);
  return { server, session };
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`play: ${(e as Error).message}\n`); process.exit(1); });
}
