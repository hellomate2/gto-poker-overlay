// ============================================================
// Simulation driver: play the real bot vs each opponent archetype for N hands,
// reporting the bot's win-rate (bb/100) and action-frequency profile so leaks
// are visible. Usage:
//   npx tsx sim/run.ts [handsPerMatchup] [seed]
//   npx tsx sim/run.ts --selftest
// ============================================================

import './fake-idb'; // installs an in-memory indexedDB so opponent tracking works
import { resetFakeIdb } from './fake-idb';
import { playHand, HandLog, HUConfig, makeRng, SeatAgent, Seat } from './holdem';
import { makeBotAgent, makeOpponent, archetypeNames } from './agents';

// Seed Math.random globally (mulberry32) so the bot's mixed-strategy randomness
// AND the Monte-Carlo equity estimates are reproducible for a given seed.
function seedGlobalRandom(seed: number): void {
  let s = seed >>> 0;
  const rng = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  Math.random = rng;
}

// Silence the engine's verbose console.log during simulation.
const realLog = console.log.bind(console);
function silence(): void { console.log = () => {}; }
function unsilence(): void { console.log = realLog; }

const BB = 20, SB = 10, START_BB = 100;

interface Stats {
  hands: number;
  netChips: number;          // bot net (seat 0)
  vpipHands: number;         // hands bot voluntarily put chips in preflop
  pfrHands: number;          // hands bot raised preflop
  sawFlop: number;           // hands that reached flop with bot still in
  wtsd: number;              // hands bot reached showdown
  // postflop action tallies
  bets: number; raises: number; calls: number; checks: number; folds: number;
  // positional preflop (vs solved-chart targets: SB open ~81%, BB defend ~74%)
  sbHands: number; sbOpen: number;        // bot as SB/button: open-raise frequency
  bbFaced: number; bbDefend: number; bb3bet: number; // bot as BB facing an SB open
}

function emptyStats(): Stats {
  return { hands: 0, netChips: 0, vpipHands: 0, pfrHands: 0, sawFlop: 0, wtsd: 0, bets: 0, raises: 0, calls: 0, checks: 0, folds: 0,
           sbHands: 0, sbOpen: 0, bbFaced: 0, bbDefend: 0, bb3bet: 0 };
}

function accumulate(st: Stats, log: HandLog, botSeat: Seat, button: Seat): void {
  st.hands++;
  st.netChips += botSeat === 0 ? log.net0 : -log.net0;
  const botActs = log.actions.filter(a => a.seat === botSeat);
  const villActs = log.actions.filter(a => a.seat !== botSeat);
  const pf = botActs.filter(a => a.street === 'preflop');
  if (pf.some(a => (a.type === 'call' || a.type === 'raise') && a.voluntary)) st.vpipHands++;
  if (pf.some(a => a.type === 'raise' && a.voluntary)) st.pfrHands++;

  // Positional preflop breakdown.
  const botIsSB = button === botSeat; // HU: button = SB
  const villRaisedPF = villActs.some(a => a.street === 'preflop' && (a.type === 'raise'));
  if (botIsSB) {
    st.sbHands++;
    if (pf.some(a => a.type === 'raise')) st.sbOpen++; // opened (raise-first-in)
  } else if (villRaisedPF) {
    // bot is BB and the SB opened -> a real defend decision
    st.bbFaced++;
    if (pf.some(a => a.type === 'raise')) { st.bb3bet++; st.bbDefend++; }
    else if (pf.some(a => a.type === 'call')) st.bbDefend++;
  }

  const postStreets = ['flop', 'turn', 'river'];
  const post = botActs.filter(a => postStreets.includes(a.street));
  if (post.length > 0 || (log.reachedStreet !== 'preflop' && !pf.some(a => a.type === 'fold'))) st.sawFlop++;
  if (log.wentToShowdown) st.wtsd++;
  for (const a of post) {
    if (a.type === 'bet') st.bets++;
    else if (a.type === 'raise') st.raises++;
    else if (a.type === 'call') st.calls++;
    else if (a.type === 'check') st.checks++;
    else if (a.type === 'fold') st.folds++;
  }
}

function report(name: string, st: Stats): void {
  const bb100 = (st.netChips / BB) / st.hands * 100;
  const pct = (n: number, d: number) => d > 0 ? (100 * n / d).toFixed(1) + '%' : '  n/a';
  const af = st.calls > 0 ? ((st.bets + st.raises) / st.calls).toFixed(2) : '∞';
  realLog(
    `vs ${name.padEnd(8)} | ${String(st.hands).padStart(6)}h | ` +
    `bb/100 ${(bb100 >= 0 ? '+' : '') + bb100.toFixed(1)}`.padEnd(16) + '| ' +
    `SBopen ${pct(st.sbOpen, st.sbHands).padStart(6)} BBdef ${pct(st.bbDefend, st.bbFaced).padStart(6)} BB3b ${pct(st.bb3bet, st.bbFaced).padStart(6)} | ` +
    `pf AF ${String(af).padStart(4)} | ` +
    `WTSD ${pct(st.wtsd, st.hands).padStart(6)}`,
  );
}

async function runMatchup(makeOpp: () => SeatAgent, hands: number, deckSeed: number, exploit: boolean): Promise<Stats> {
  resetFakeIdb();                       // clean opponent DB per matchup
  // Fresh deck RNG seeded identically for the GTO and EXPLOIT runs of a matchup,
  // so both modes see the SAME card sequence (paired comparison -> the bb/100
  // difference is the exploit adjuster's effect, not card luck).
  const cfg: HUConfig = { bb: BB, sb: SB, startStackBB: START_BB, rng: makeRng(deckSeed) };
  const bot = makeBotAgent('BOT', { exploit });
  const opp = makeOpp();
  const st = emptyStats();
  for (let h = 0; h < hands; h++) {
    const button: Seat = (h % 2) as Seat; // alternate the button; bot is always seat 0
    const log = await playHand([bot, opp], button, cfg, h + 1);
    accumulate(st, log, 0, button);
    if (exploit && log.finalState) await bot.observe?.(log.finalState);
  }
  return st;
}

// ---- self-test: validate the ENGINE before trusting any strategy numbers ----
async function selftest(): Promise<void> {
  unsilence();
  realLog('=== SIM SELF-TEST (engine correctness) ===');
  const rng = makeRng(999);
  const cfg: HUConfig = { bb: BB, sb: SB, startStackBB: START_BB, rng };

  // 1) chip conservation over 2000 random-vs-random hands (playHand asserts it).
  const randomA = makeOpponent('lag', 1);
  const randomB = makeOpponent('fish', 2);
  let net = 0;
  for (let h = 0; h < 2000; h++) {
    const log = await playHand([randomA, randomB], (h % 2) as Seat, cfg, h + 1);
    net += log.net0;
  }
  realLog(`1) chip conservation over 2000 hands: PASS (no leak thrown). net(seat0)=${net} chips`);

  // 2) an always-fold seat must lose, an always-jam seat vs always-fold wins the blinds.
  const alwaysFold: SeatAgent = { name: 'FOLD', act: (v) => (v.canCheck ? { action: 'check' } : { action: 'fold' }) };
  const alwaysJam: SeatAgent = { name: 'JAM', act: () => ({ action: 'allin' }) };
  let jamNet = 0; const N = 400;
  for (let h = 0; h < N; h++) { const log = await playHand([alwaysJam, alwaysFold], (h % 2) as Seat, cfg, h + 1); jamNet += log.net0; }
  const jamBb100 = (jamNet / BB) / N * 100;
  realLog(`2) always-jam vs always-fold: jam bb/100 = ${jamBb100.toFixed(1)} (must be POSITIVE; jam steals blinds when folder is BB, loses when folder open-folds SB)`);

  // 3) two identical players net ~0 over many hands (within noise).
  let mirrorNet = 0; const M = 3000;
  for (let h = 0; h < M; h++) { const a = makeOpponent('tag', 100); const b = makeOpponent('tag', 100); const log = await playHand([a, b], (h % 2) as Seat, cfg, h + 1); mirrorNet += log.net0; }
  realLog(`3) mirror TAG vs TAG over ${M} hands: net seat0 = ${mirrorNet} chips (${((mirrorNet/BB)/M*100).toFixed(1)} bb/100, should be near 0)`);
  realLog('=== SELF-TEST DONE ===');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--selftest') { await selftest(); return; }

  const hands = parseInt(args[0] || '2000', 10);
  const seed = parseInt(args[1] || '42', 10);
  seedGlobalRandom(seed);
  silence();

  unsilence();
  realLog(`\n=== BOT vs OPPONENT ARCHETYPES — ${hands} hands each, ${START_BB}bb deep, seed ${seed} ===`);
  realLog('(bb/100 = bot win-rate; positive = bot winning. VPIP/PFR/AF describe the BOT.)\n');
  silence();

  const bb100 = (st: Stats) => (st.netChips / BB) / st.hands * 100;

  unsilence();
  realLog('GTO  = bot with no opponent read (pure equilibrium).');
  realLog('EXPL = bot tracking the opponent (profiler + exploit adjuster active).\n');
  silence();

  const rows: { kind: string; gto: Stats; expl: Stats }[] = [];
  let ki = 0;
  for (const kind of archetypeNames()) {
    const deckSeed = seed * 131 + (ki++) * 977;   // same deck for GTO & EXPL of this kind
    const oppSeed = 1000 + kind.length;
    const gto = await runMatchup(() => makeOpponent(kind, oppSeed), hands, deckSeed, false);
    const expl = await runMatchup(() => makeOpponent(kind, oppSeed), hands, deckSeed, true);
    rows.push({ kind, gto, expl });
    unsilence();
    const g = bb100(gto), e = bb100(expl);
    realLog(
      `vs ${kind.padEnd(7)} | GTO ${(g >= 0 ? '+' : '') + g.toFixed(1)}`.padEnd(26) +
      `| EXPL ${(e >= 0 ? '+' : '') + e.toFixed(1)}`.padEnd(16) +
      `| lift ${(e - g >= 0 ? '+' : '') + (e - g).toFixed(1)} bb/100 | ` +
      `SBopen ${(100 * gto.sbOpen / Math.max(1, gto.sbHands)).toFixed(0)}% BBdef ${(100 * gto.bbDefend / Math.max(1, gto.bbFaced)).toFixed(0)}% | pf AF(GTO) ${(gto.calls ? (gto.bets + gto.raises) / gto.calls : 0).toFixed(2)}`,
    );
    silence();
  }

  unsilence();
  const tot = (sel: (r: { gto: Stats; expl: Stats }) => Stats) => {
    const net = rows.reduce((s, r) => s + sel(r).netChips, 0);
    const h = rows.reduce((s, r) => s + sel(r).hands, 0);
    return (net / BB) / h * 100;
  };
  realLog(`\nAGGREGATE bb/100 — GTO: ${tot(r => r.gto).toFixed(1)} | EXPLOIT: ${tot(r => r.expl).toFixed(1)}`);
  realLog('Preflop target check: SBopen ~81% (solved SB-RFI), BBdef ~74% (solved BB-vs-open).');
}

main().catch(e => { unsilence(); console.error(e); process.exit(1); });
