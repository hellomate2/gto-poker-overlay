// ============================================================
// Local play app (sim/play): session state transitions, strict action
// validation shared with the ring engine, all-in EV adjustment, bb/100 + CI
// math, hand history, and the HTTP API with a scripted bot.
// ============================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import {
  playRingHand, validateAction, clampRaiseTo, SeatAgent, SeatView, ActResult, RingConfig,
} from '../sim/ring';
import { tQuantile, tCdf, bb100CI, incBeta } from '../sim/play/stats';
import { exactEquity, allInAdjustment } from '../sim/play/allin-ev';
import { PlaySession, PlayError, SessionConfig, HUMAN } from '../sim/play/session';
import { startServer } from '../sim/play/server';
import { BotInfo } from '../sim/play/bots';
import { cardToId, parseCard } from '../src/core/cfr/card-utils';

const id = (s: string) => cardToId(parseCard(s));
const BB = 20, SB = 10;
const INFO: BotInfo = { kind: 'test', label: 'scripted test bot' };

/** Bot that always checks or calls (never folds, never raises). */
function stationBot(): SeatAgent {
  return { name: 'station', act: (v: SeatView): ActResult => ({ action: v.canCheck ? 'check' : 'call' }) };
}

/** Bot that plays a fixed list of actions, then checks/calls. */
function scriptBot(script: ActResult[]): SeatAgent {
  let k = 0;
  return { name: 'script', act: (v: SeatView) => script[k++] ?? { action: v.canCheck ? 'check' : 'call' } };
}

function cfg(extra: Partial<SessionConfig> = {}): SessionConfig {
  return { sb: SB, bb: BB, humanStack: 100 * BB, botStack: 100 * BB, seed: 11, botDelayMs: 0, historyDir: null, ...extra };
}

/** Let the engine's promise chain run. */
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

// ---------------------------------------------------------------------------

describe('Student t and bb/100 interval', () => {
  it('matches closed forms for df = 1 and df = 2, and tends to the normal', () => {
    // df=1 is Cauchy: q = tan(pi (p - 1/2)).
    expect(tQuantile(0.975, 1)).toBeCloseTo(Math.tan(Math.PI * 0.475), 6);
    // df=2: q = (2p - 1) / sqrt(2 p (1 - p)).
    expect(tQuantile(0.975, 2)).toBeCloseTo(0.95 / Math.sqrt(2 * 0.975 * 0.025), 6);
    // Normal 97.5% quantile is 1.959964 (to 6 places).
    expect(tQuantile(0.975, 1e7)).toBeCloseTo(1.959964, 4);
    // Monotone in df.
    expect(tQuantile(0.975, 5)).toBeGreaterThan(tQuantile(0.975, 30));
  });
  it('t CDF is symmetric and the incomplete beta hits its boundaries', () => {
    for (const df of [1, 3, 17, 250]) {
      for (const t of [0.3, 1.1, 2.5]) expect(tCdf(t, df) + tCdf(-t, df)).toBeCloseTo(1, 12);
      expect(tCdf(0, df)).toBeCloseTo(0.5, 12);
    }
    expect(incBeta(0, 2, 3)).toBe(0);
    expect(incBeta(1, 2, 3)).toBe(1);
    // I_x(1, 1) = x
    expect(incBeta(0.37, 1, 1)).toBeCloseTo(0.37, 12);
  });
  it('bb/100 and its half-width from per-hand bb', () => {
    expect(bb100CI([])).toEqual({ n: 0, total: 0, bb100: 0, ci95: null, sdPerHand: null });
    const one = bb100CI([2.5]);
    expect(one.bb100).toBe(250);
    expect(one.ci95).toBeNull();
    // [2, 0, -2]: mean 0, sd 2, df 2.
    const r = bb100CI([2, 0, -2]);
    expect(r.bb100).toBe(0);
    expect(r.sdPerHand).toBeCloseTo(2, 12);
    const t2 = 0.95 / Math.sqrt(2 * 0.975 * 0.025);
    expect(r.ci95!).toBeCloseTo(100 * t2 * 2 / Math.sqrt(3), 6);
    // Shifting every hand by +1 bb moves bb/100 by +100 and leaves the width alone.
    const s = bb100CI([3, 1, -1]);
    expect(s.bb100).toBeCloseTo(100, 12);
    expect(s.ci95!).toBeCloseTo(r.ci95!, 9);
  });
});

describe('strict action validation (shared with the ring engine)', () => {
  /** Capture the first view the human seat gets for a given setup. */
  async function firstView(button: number, stacks?: number[], botFirst?: ActResult): Promise<SeatView> {
    let got: SeatView | null = null;
    const human: SeatAgent = { name: 'H', act: (v) => { got ??= v; return { action: v.canCheck ? 'check' : 'fold' }; } };
    const c: RingConfig = { bb: BB, sb: SB, startStackBB: 100, rng: Math.random, seatStacks: stacks };
    await playRingHand([human, scriptBot(botFirst ? [botFirst] : [])], button, c, 1);
    return got!;
  }

  it('exposes min/max raise-to and rejects instead of coercing', async () => {
    const v = await firstView(0); // human on the button (SB) facing the BB
    expect(v.toCall).toBe(10);
    expect(v.minTo).toBe(40);
    expect(v.maxTo).toBe(2000);
    expect(validateAction(v, { action: 'check' }).ok).toBe(false);
    expect(validateAction(v, { action: 'call' }).ok).toBe(true);
    expect(validateAction(v, { action: 'fold' }).ok).toBe(true);
    expect(validateAction(v, { action: 'raise', amount: 39 })).toEqual({ ok: false, error: 'minimum raise is to 40' });
    expect(validateAction(v, { action: 'raise', amount: 2001 }).ok).toBe(false);
    expect(validateAction(v, { action: 'raise', amount: 55.5 }).ok).toBe(false);
    expect(validateAction(v, { action: 'raise' }).ok).toBe(false);
    expect(validateAction(v, { action: 'shove' }).ok).toBe(false);
    expect(validateAction(v, { action: 'raise', amount: 40 })).toEqual({ ok: true, act: { action: 'raise', toAmount: 40 } });
    expect(validateAction(v, { action: 'allin' })).toEqual({ ok: true, act: { action: 'raise', toAmount: 2000 } });
  });

  it('a validated raise-to is applied unchanged by the engine clamp', async () => {
    const v = await firstView(0);
    for (const to of [40, 41, 77, 1999, 2000]) {
      const r = validateAction(v, { action: 'raise', amount: to });
      expect(r.ok).toBe(true);
      if (r.ok) expect(clampRaiseTo('raise', r.act.toAmount, v.state.currentBet, v.minTo - v.state.currentBet, v.state.players[v.seat].currentBet, v.heroStack)).toBe(to);
    }
  });

  it('fold is refused when checking is free; a short stack can only shove', async () => {
    // Bot on the button limps; human (BB) may check.
    const v = await firstView(1, undefined, { action: 'call' });
    expect(v.canCheck).toBe(true);
    expect(validateAction(v, { action: 'fold' }).ok).toBe(false);
    expect(validateAction(v, { action: 'call' }).ok).toBe(false);
    expect(validateAction(v, { action: 'check' }).ok).toBe(true);
    // Human with 30 chips on the button: min raise-to 40 > all-in 30.
    const s = await firstView(0, [30, 2000]);
    expect(s.maxTo).toBe(30);
    expect(validateAction(s, { action: 'raise', amount: 30 }).ok).toBe(true);
    expect(validateAction(s, { action: 'raise', amount: 25 }).ok).toBe(false);
    // Human with 15 chips: after posting the SB only a call (all-in) is possible.
    const t = await firstView(0, [15, 2000]);
    expect(validateAction(t, { action: 'raise', amount: 15 }).ok).toBe(false);
    expect(validateAction(t, { action: 'call' }).ok).toBe(true);
  });
});

describe('all-in EV adjustment', () => {
  it('enumerates every run-out exactly', () => {
    const river = exactEquity([id('Ah'), id('Kh')], [id('Qs'), id('Qd')], ['2c', '7d', '9s', 'Jh', '3c'].map(id));
    expect(river).toEqual({ win: 0, tie: 0, lose: 1, runouts: 1 });
    const turn = exactEquity([id('Ah'), id('Ac')], [id('Kd'), id('Kh')], ['As', 'Ad', '7c', '2h'].map(id));
    expect(turn.runouts).toBe(44);
    expect(turn.win).toBe(1);
    const flop = exactEquity([id('Ah'), id('Kh')], [id('Qs'), id('Qd')], ['2c', '7d', '9s'].map(id));
    expect(flop.runouts).toBe(990);
    expect(flop.win + flop.tie + flop.lose).toBeCloseTo(1, 12);
    // Same hand in different suits preflop: the two sides are mirror images.
    const pf = exactEquity([id('As'), id('Ks')], [id('Ah'), id('Kh')], []);
    expect(pf.runouts).toBe(1712304);
    expect(pf.win).toBeCloseTo(pf.lose, 12);
    expect(() => exactEquity([id('As'), id('Ks')], [id('As'), id('Kh')], [])).toThrow();
  });

  async function play(stacks: number[], human: ActResult[], bot: ActResult[], deck?: number[]) {
    const c: RingConfig = { bb: BB, sb: SB, startStackBB: 100, rng: Math.random, seatStacks: stacks };
    return playRingHand([scriptBot(human), scriptBot(bot)], 0, c, 1, deck);
  }
  const deck = (() => {
    // seat0: As Ks, seat1: Qh Qd, board 2c 7d 9s Jh 3c, rest in id order.
    const first = ['As', 'Qh', 'Ks', 'Qd', '2c', '7d', '9s', 'Jh', '3c'].map(id);
    return [...first, ...Array.from({ length: 52 }, (_, i) => i).filter(i => !first.includes(i))];
  })();

  it('preflop all-in: EV uses matched chips and exact preflop equity', async () => {
    const log = await play([2000, 1000], [{ action: 'allin' }], [{ action: 'call' }], deck);
    expect(log.committed).toEqual([2000, 1000]);
    const ai = allInAdjustment(log, HUMAN)!;
    expect(ai.boardCards).toBe(0);
    expect(ai.matched).toBe(1000);
    const eq = exactEquity([id('As'), id('Ks')], [id('Qh'), id('Qd')], []);
    expect(ai.evNet).toBeCloseTo(1000 * (eq.win - eq.lose), 9);
    // Realized result on this board (QQ holds) is -1000; EV is much closer to 0.
    expect(log.nets[0]).toBe(-1000);
    expect(Math.abs(ai.evNet)).toBeLessThan(200);
  });

  it('flop all-in uses the flop; folds and river showdowns are not adjusted', async () => {
    // Human on the button: limp, bot checks its option; flop: bot checks, human shoves, bot calls.
    const flop = await play([2000, 2000], [{ action: 'call' }, { action: 'allin' }], [{ action: 'check' }, { action: 'check' }, { action: 'call' }], deck);
    const ai = allInAdjustment(flop, HUMAN);
    expect(ai).not.toBeNull();
    expect(ai!.boardCards).toBe(3);
    expect(ai!.equity.runouts).toBe(990);
    const fold = await play([2000, 2000], [{ action: 'raise', toAmount: 60 }], [{ action: 'fold' }], deck);
    expect(allInAdjustment(fold, HUMAN)).toBeNull();
    const river = await play([2000, 2000], [], [], deck); // check/call down
    expect(river.wentToShowdown).toBe(true);
    expect(allInAdjustment(river, HUMAN)).toBeNull();
  });
});

describe('PlaySession state machine', () => {
  const tmp: string[] = [];
  afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('idle -> human -> done, with errors on out-of-turn and illegal actions', async () => {
    const s = new PlaySession(cfg(), stationBot(), INFO);
    expect(s.phase).toBe('idle');
    expect(() => s.act({ action: 'call' })).toThrow(PlayError);
    s.deal();
    await flush();
    // Hand 1: human on the button acts first preflop.
    expect(s.phase).toBe('human');
    const snap = s.snapshot() as any;
    expect(snap.button).toBe('you');
    expect(snap.you.hole).toHaveLength(2);
    expect(snap.bot.hole).toBeNull();
    expect(snap.legal.call).toBe(true);
    expect(snap.legal.raise.minTo).toBe(40);
    expect(snap.you.bet).toBe(10);
    expect(snap.bot.bet).toBe(20);
    expect(() => s.deal()).toThrow(/in progress/);
    const v0 = s.version;
    expect(() => s.act({ action: 'raise', amount: 21 })).toThrow(/minimum raise/);
    expect(s.version).toBe(v0);           // illegal input changes nothing
    s.act({ action: 'fold' });
    await flush();
    expect(s.phase).toBe('done');
    const done = s.snapshot() as any;
    expect(done.result.netBb).toBe(-0.5);
    expect(done.bot.hole).toBeNull();     // no showdown, cards stay hidden
    expect(done.you.stack).toBe(2000 - 10);
    expect(done.session.hands).toBe(1);
    expect(done.legal).toBeNull();
  });

  it('button alternates and the bot acts first preflop on its button', async () => {
    const s = new PlaySession(cfg(), scriptBot([{ action: 'raise', toAmount: 60 }]), INFO);
    s.deal(); await flush();
    s.act({ action: 'fold' }); await flush();
    s.deal(); await flush();
    const snap = s.snapshot() as any;
    expect(snap.hand).toBe(2);
    expect(snap.button).toBe('bot');
    expect(snap.phase).toBe('human');
    expect(snap.actions).toEqual([{ who: 'bot', street: 'preflop', type: 'raise', amount: 60 }]);
    expect(snap.legal.callAmount).toBe(40);
    expect(snap.legal.raise.minTo).toBe(100);
    expect(snap.bot.bet).toBe(60);
    expect(snap.you.bet).toBe(20);
  });

  it('showdown reveals the bot hand only at the end, and the session math adds up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'play-'));
    tmp.push(dir);
    const s = new PlaySession(cfg({ historyDir: dir, now: () => new Date(2026, 9, 9, 3, 0, 0) }), stationBot(), INFO);
    const nets: number[] = [];
    for (let h = 0; h < 6; h++) {
      s.deal(); await flush();
      let guard = 0;
      while (s.phase === 'human') {
        const snap = s.snapshot() as any;
        expect(snap.bot.hole).toBeNull();
        s.act({ action: snap.legal.check ? 'check' : 'call' });
        await flush();
        if (++guard > 20) throw new Error('hand did not end');
      }
      expect(s.phase).toBe('done');
      const done = s.snapshot() as any;
      expect(done.result.showdown).toBe(true);
      expect(done.bot.hole).toHaveLength(2);
      expect(done.board).toHaveLength(5);
      expect(done.you.stack + done.bot.stack).toBe(4000);
      nets.push(done.result.netBb);
    }
    const st = s.stats();
    expect(st.hands).toBe(6);
    expect(st.net.total).toBeCloseTo(nets.reduce((a, b) => a + b, 0), 9);
    expect(st.net.bb100).toBeCloseTo(100 * st.net.total / 6, 9);
    expect(st.allInAdj.total).toBeCloseTo(st.net.total, 9); // no all-ins: adjusted == realized
    expect(st.luckBb).toBeCloseTo(0, 9);
    const file = join(dir, '2026-10-09.jsonl');
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(6);
    expect(lines.map(l => l.netBb)).toEqual(nets);
    expect(lines[0].botCards).toHaveLength(2);
    expect(lines[0].button).toBe('you');
    expect(lines[1].button).toBe('bot');
  });

  it('deals are reproducible from the seed', async () => {
    const holes = async () => {
      const s = new PlaySession(cfg({ seed: 99 }), stationBot(), INFO);
      const out: string[][] = [];
      for (let h = 0; h < 3; h++) {
        s.deal(); await flush();
        out.push((s.snapshot() as any).you.hole);
        while (s.phase === 'human') { s.act({ action: (s.snapshot() as any).legal.fold ? 'fold' : 'check' }); await flush(); }
      }
      return out;
    };
    expect(await holes()).toEqual(await holes());
  });

  it('records an all-in with its EV and luck', async () => {
    const s = new PlaySession(cfg(), stationBot(), INFO);
    s.deal(); await flush();
    s.act({ action: 'allin' }); await flush();
    expect(s.phase).toBe('done');
    const r = (s.snapshot() as any).result;
    expect(r.allIn).not.toBeNull();
    expect(r.allIn.boardCards).toBe(0);
    expect(Math.abs(r.netBb)).toBe(100);
    expect(r.adjNetBb).toBeCloseTo(r.allIn.evNetBb, 12);
    expect(s.stats().luckBb).toBeCloseTo(r.netBb - r.adjNetBb, 9);
  });

  it('waits at least the bot delay before a bot action', async () => {
    const s = new PlaySession(cfg({ botDelayMs: 120 }), stationBot(), INFO);
    s.deal(); await flush();
    const t0 = Date.now();
    s.act({ action: 'call' });
    expect(s.phase).toBe('bot');
    await s.settled();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
    expect(s.phase).toBe('human'); // flop, bot checked, human to act
  });

  it('presets are legal, sorted, unique and end with all-in', async () => {
    const s = new PlaySession(cfg(), stationBot(), INFO);
    s.deal(); await flush();
    const R = (s.snapshot() as any).legal.raise;
    const tos = R.presets.map((p: any) => p.to);
    expect(tos[tos.length - 1]).toBe(R.maxTo);
    expect(new Set(tos).size).toBe(tos.length);
    for (const t of tos) expect(t).toBeGreaterThanOrEqual(R.minTo);
    expect([...tos].sort((a, b) => a - b)).toEqual(tos);
  });
});

describe('HTTP API', () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise(r => server!.close(r)); server = null; });

  it('plays hands end to end over HTTP with a scripted bot', async () => {
    const s = new PlaySession(cfg({ botDelayMs: 5 }), stationBot(), INFO);
    server = await startServer(s, 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const j = async (path: string, body?: unknown) => {
      const r = await fetch(base + path, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() as any };
    };
    expect((await j('/api/action', { action: 'call' })).status).toBe(409);
    expect((await j('/nope')).status).toBe(404);
    const page = await fetch(base + '/');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Heads-up');
    for (let h = 0; h < 4; h++) {
      let st = (await j('/api/deal', {})).body;
      expect(st.hand).toBe(h + 1);
      let guard = 0;
      while (st.phase !== 'done') {
        if (st.phase === 'bot') { st = (await j(`/api/state?since=${st.version}&wait=5000`)).body; continue; }
        expect(st.phase).toBe('human');
        expect(st.bot.hole).toBeNull();
        const bad = await j('/api/action', { action: 'raise', amount: 1 });
        expect(bad.status).toBe(400);
        st = (await j('/api/action', { action: st.legal.check ? 'check' : 'call' })).body;
        if (++guard > 20) throw new Error('hand did not end');
      }
      expect(st.result.showdown).toBe(true);
      expect(st.bot.hole).toHaveLength(2);
    }
    const fin = (await j('/api/state')).body;
    expect(fin.session.hands).toBe(4);
    expect((await j('/api/action', { foo: 1 })).status).toBe(400); // missing action
  });
});
