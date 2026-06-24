// ============================================================
// GTO Trainer — standalone study tool
//
// Two modes:
//  1. Preflop — uses the real GTO charts in src/core/ranges/preflop.ts.
//     Preflop is not solved live; the charts ARE the GTO solution, so
//     grading against them is exact.
//  2. Postflop — uses solutions produced by TexasSolver (see solver/).
//
// This is a study/analysis tool. It does NOT connect to any poker
// site and does not play for you.
// ============================================================

import './trainer.css';
import { RFI_RANGES, THREE_BET_RANGES, getHandFrequency, RangeMatrix } from '../core/ranges/preflop';
import { idToCard, createDeck, shuffleDeck, handGroupName } from '../core/cfr/card-utils';
import { CardId } from '../types/poker';
import { SAMPLE_SPOTS } from './spots';
import { SolvedSpot, SolvedHand, TrainerStats } from './types';

// webpack provides require.context at build time for auto-loading generated solves
declare const require: { context(path: string, deep: boolean, filter: RegExp): {
  keys(): string[]; (id: string): any;
} };

const RANKS_HIGH_TO_LOW = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const SUIT_SYMBOL: Record<string, string> = { h: '♥', d: '♦', c: '♣', s: '♠' };

// ---------- small helpers ----------
const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const pct = (x: number) => `${Math.round(x * 100)}%`;
function el(tag: string, cls?: string, html?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
function cardHTML(id: CardId): string {
  const c = idToCard(id);
  return `<span class="card suit-${c.suit}">${c.rank}<span class="pip">${SUIT_SYMBOL[c.suit]}</span></span>`;
}

// matrix index (A=0..2=12) from a CardId
const matIdx = (id: CardId) => 12 - Math.floor(id / 4);

// ---------- session stats ----------
const stats: TrainerStats = { hands: 0, scoreSum: 0, streak: 0, bestStreak: 0, mistakes: [] };

function recordResult(label: string, you: string, gto: string, score: number) {
  stats.hands += 1;
  stats.scoreSum += score;
  if (score >= 0.5) {
    stats.streak += 1;
    stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
  } else {
    stats.streak = 0;
    stats.mistakes.unshift({ label, you, gto, score });
    stats.mistakes = stats.mistakes.slice(0, 8);
  }
  renderStats();
}

function renderStats() {
  const acc = stats.hands ? stats.scoreSum / stats.hands : 0;
  $('#stat-hands').textContent = String(stats.hands);
  $('#stat-score').textContent = stats.hands ? pct(acc) : '—';
  $('#stat-streak').textContent = String(stats.streak);
  $('#stat-best').textContent = String(stats.bestStreak);
  const ml = $('#mistakes');
  ml.innerHTML = '';
  if (!stats.mistakes.length) {
    ml.appendChild(el('div', 'muted', 'No leaks yet. Keep going.'));
  } else {
    for (const m of stats.mistakes) {
      ml.appendChild(el('div', 'mistake', `<b>${m.label}</b> — you: ${m.you}, GTO: ${m.gto}`));
    }
  }
}

// ============================================================
// Range grid (13x13) renderer
// ============================================================
function renderRangeGrid(range: RangeMatrix, highlight: { r: number; c: number } | null): HTMLElement {
  const grid = el('div', 'range-grid');
  for (let r = 0; r < 13; r++) {
    for (let c = 0; c < 13; c++) {
      const freq = range[r][c];
      const cell = el('div', 'rg-cell');
      // color: green intensity by frequency
      const g = Math.round(40 + freq * 150);
      cell.style.background = freq > 0 ? `rgba(40, ${g}, 80, ${0.25 + freq * 0.75})` : 'rgba(255,255,255,0.03)';
      let label: string;
      if (r === c) label = `${RANKS_HIGH_TO_LOW[r]}${RANKS_HIGH_TO_LOW[c]}`;
      else if (r < c) label = `${RANKS_HIGH_TO_LOW[r]}${RANKS_HIGH_TO_LOW[c]}s`;
      else label = `${RANKS_HIGH_TO_LOW[c]}${RANKS_HIGH_TO_LOW[r]}o`;
      cell.innerHTML = `<span>${label}</span>`;
      if (highlight && highlight.r === r && highlight.c === c) cell.classList.add('hl');
      grid.appendChild(cell);
    }
  }
  return grid;
}

function handToCell(c1: CardId, c2: CardId): { r: number; c: number } {
  const m1 = matIdx(c1), m2 = matIdx(c2);
  const suited = c1 % 4 === c2 % 4;
  if (m1 === m2) return { r: m1, c: m2 };
  return suited ? { r: Math.min(m1, m2), c: Math.max(m1, m2) } : { r: Math.max(m1, m2), c: Math.min(m1, m2) };
}

// ============================================================
// PREFLOP TRAINER
// ============================================================
const RFI_POSITIONS = ['UTG', 'MP', 'CO', 'BTN', 'SB'];

interface PreflopSpot {
  mode: 'rfi' | '3bet';
  range: RangeMatrix;
  c1: CardId; c2: CardId;
  pAgg: number;          // GTO frequency of the aggressive action
  aggLabel: string;      // "Raise" / "3-Bet"
  passLabel: string;     // "Fold"
  scenario: string;      // human description
}

function dealPreflop(mode: 'rfi' | '3bet'): PreflopSpot {
  const deck = shuffleDeck(createDeck());
  const c1 = deck[0], c2 = deck[1];
  if (mode === 'rfi') {
    const pos = RFI_POSITIONS[Math.floor(Math.random() * RFI_POSITIONS.length)];
    const range = RFI_RANGES[pos];
    return {
      mode, range, c1, c2,
      pAgg: getHandFrequency(range, c1, c2),
      aggLabel: 'Raise', passLabel: 'Fold',
      scenario: `You're <b>${pos}</b>. Folded to you. Open-raise or fold?`,
    };
  } else {
    const keys = Object.keys(THREE_BET_RANGES);
    const key = keys[Math.floor(Math.random() * keys.length)];
    const [hero, , villain] = key.split('_');
    const range = THREE_BET_RANGES[key];
    return {
      mode, range, c1, c2,
      pAgg: getHandFrequency(range, c1, c2),
      aggLabel: '3-Bet', passLabel: 'Fold/Call',
      scenario: `You're in the <b>${hero}</b> facing a <b>${villain}</b> open. 3-bet or not?`,
    };
  }
}

let curPre: PreflopSpot | null = null;
let preMode: 'rfi' | '3bet' = 'rfi';

function newPreflop() {
  curPre = dealPreflop(preMode);
  const root = $('#play');
  root.innerHTML = '';
  root.appendChild(el('div', 'scenario', curPre.scenario));
  const hand = el('div', 'hero-hand');
  hand.innerHTML = cardHTML(curPre.c1) + cardHTML(curPre.c2) +
    `<span class="hand-name">${handGroupName(curPre.c1, curPre.c2)}</span>`;
  root.appendChild(hand);

  const actions = el('div', 'actions');
  const aggBtn = el('button', 'btn agg', curPre.aggLabel);
  const passBtn = el('button', 'btn pass', curPre.passLabel);
  aggBtn.onclick = () => answerPreflop(true);
  passBtn.onclick = () => answerPreflop(false);
  actions.appendChild(passBtn);
  actions.appendChild(aggBtn);
  root.appendChild(actions);
  root.appendChild(el('div', 'feedback', ''));
}

function answerPreflop(choseAgg: boolean) {
  if (!curPre) return;
  const p = curPre.pAgg;
  const score = choseAgg ? p : 1 - p;
  const label = `${handGroupName(curPre.c1, curPre.c2)} (${curPre.scenario.replace(/<[^>]+>/g, '')})`;

  let verdict: string, cls: string;
  if (p >= 0.9) { verdict = `Pure ${curPre.aggLabel}`; cls = choseAgg ? 'good' : 'bad'; }
  else if (p <= 0.1) { verdict = `Pure ${curPre.passLabel}`; cls = choseAgg ? 'bad' : 'good'; }
  else { verdict = `Mixed — ${curPre.aggLabel} ${pct(p)}`; cls = score >= 0.5 ? 'ok' : 'meh'; }

  recordResult(label, choseAgg ? curPre.aggLabel : curPre.passLabel,
    p >= 0.5 ? curPre.aggLabel : curPre.passLabel, score);

  const fb = $('.feedback');
  fb.className = `feedback show ${cls}`;
  fb.innerHTML = `
    <div class="verdict">${verdict} &nbsp;·&nbsp; your score ${pct(score)}</div>
    <div class="mix">GTO mix: ${curPre.aggLabel} <b>${pct(p)}</b> / ${curPre.passLabel} <b>${pct(1 - p)}</b></div>
  `;
  // lock buttons, show grid + next
  document.querySelectorAll('.actions .btn').forEach(b => (b as HTMLButtonElement).disabled = true);
  const root = $('#play');
  root.appendChild(el('div', 'grid-title', 'Full GTO range for this spot (your hand highlighted):'));
  root.appendChild(renderRangeGrid(curPre.range, handToCell(curPre.c1, curPre.c2)));
  const next = el('button', 'btn next', 'Next hand →');
  next.onclick = newPreflop;
  root.appendChild(next);
}

// ============================================================
// POSTFLOP TRAINER (TexasSolver-powered)
// ============================================================
let allSpots: SolvedSpot[] = [...SAMPLE_SPOTS];
let curSpot: SolvedSpot | null = null;
let curHand: SolvedHand | null = null;

// At build time we also try to merge any generated solves placed in
// src/trainer/spots/. They are optional; the sample always works.
function loadGeneratedSpots() {
  try {
    // webpack require.context picks up generated JSON solves if present
    const ctx = require.context('./spots', false, /\.json$/);
    const gen: SolvedSpot[] = ctx.keys().map((k: string) => ctx(k));
    if (gen.length) allSpots = [...gen, ...SAMPLE_SPOTS];
  } catch {
    /* no generated spots — sample only */
  }
}

function newPostflop() {
  curSpot = allSpots[Math.floor(Math.random() * allSpots.length)];
  curHand = curSpot.hands[Math.floor(Math.random() * curSpot.hands.length)];
  const root = $('#play');
  root.innerHTML = '';

  root.appendChild(el('div', 'scenario', `${curSpot.title}`));
  const board = el('div', 'board');
  board.innerHTML = curSpot.board.map(s => cardHTML(cardStrToId(s))).join('');
  root.appendChild(board);
  root.appendChild(el('div', 'spot-meta',
    `Pot ${curSpot.pot}bb · stacks ${curSpot.effectiveStack}bb · you are ${curSpot.toAct.toUpperCase()}` +
    (curSpot.source === 'sample' ? ' · <span class="tag">sample</span>' : ' · <span class="tag solver">TexasSolver</span>')));

  const hand = el('div', 'hero-hand');
  const [h1, h2] = splitCombo(curHand.hand);
  hand.innerHTML = cardHTML(h1) + cardHTML(h2);
  root.appendChild(hand);

  const actions = el('div', 'actions');
  for (const a of curSpot.actions) {
    const label = (curSpot.actionLabels && curSpot.actionLabels[a]) || a;
    const b = el('button', 'btn', label);
    b.onclick = () => answerPostflop(a);
    actions.appendChild(b);
  }
  root.appendChild(actions);
  root.appendChild(el('div', 'feedback', ''));
}

function answerPostflop(action: string) {
  if (!curSpot || !curHand) return;
  const freqs = curHand.freqs;
  const score = freqs[action] ?? 0;
  const best = curSpot.actions.reduce((a, b) => ((freqs[b] ?? 0) > (freqs[a] ?? 0) ? b : a));
  const bestLabel = (curSpot.actionLabels && curSpot.actionLabels[best]) || best;
  const youLabel = (curSpot.actionLabels && curSpot.actionLabels[action]) || action;

  recordResult(`${curHand.hand} on ${curSpot.board.join(' ')}`, youLabel, bestLabel, score);

  const fb = $('.feedback');
  fb.className = `feedback show ${score >= 0.5 ? 'good' : score >= 0.25 ? 'ok' : 'bad'}`;
  const mix = curSpot.actions
    .map(a => `${(curSpot!.actionLabels && curSpot!.actionLabels[a]) || a} <b>${pct(freqs[a] ?? 0)}</b>`)
    .join(' / ');
  fb.innerHTML = `
    <div class="verdict">Your action ${youLabel} ran at <b>${pct(score)}</b> frequency</div>
    <div class="mix">Solver mix: ${mix}</div>
    ${curSpot.note ? `<div class="muted small">${curSpot.note}</div>` : ''}`;
  document.querySelectorAll('.actions .btn').forEach(b => (b as HTMLButtonElement).disabled = true);
  const next = el('button', 'btn next', 'Next spot →');
  next.onclick = newPostflop;
  $('#play').appendChild(next);
}

// combo string helpers ("AhKh" -> two CardIds)
function cardStrToId(s: string): CardId {
  const rank = '23456789TJQKA'.indexOf(s[0]);
  const suit = 'hdcs'.indexOf(s[1]);
  return rank * 4 + suit;
}
function splitCombo(combo: string): [CardId, CardId] {
  return [cardStrToId(combo.slice(0, 2)), cardStrToId(combo.slice(2, 4))];
}

// ============================================================
// App shell / mode switching
// ============================================================
type Mode = 'pre-rfi' | 'pre-3bet' | 'postflop';
let mode: Mode = 'pre-rfi';

function setMode(m: Mode) {
  mode = m;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', (t as HTMLElement).dataset.mode === m));
  if (m === 'pre-rfi') { preMode = 'rfi'; newPreflop(); }
  else if (m === 'pre-3bet') { preMode = '3bet'; newPreflop(); }
  else { newPostflop(); }
}

function boot() {
  loadGeneratedSpots();
  document.querySelectorAll('.tab').forEach(t =>
    (t as HTMLElement).addEventListener('click', () => setMode((t as HTMLElement).dataset.mode as Mode)));
  renderStats();
  setMode('pre-rfi');
}

document.addEventListener('DOMContentLoaded', boot);
