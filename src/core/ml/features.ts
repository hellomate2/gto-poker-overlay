import { CardId } from '../../types/poker';
import { evaluateHand, HAND_CATEGORY } from '../equity/hand-eval';
import { createDeck, removeCards } from '../cfr/card-utils';

// ============================================================
// Shared postflop feature encoder.
//
// THIS MODULE IS THE SINGLE SOURCE OF TRUTH FOR FEATURES.
// It is imported by BOTH the offline prep script (ml/prep.ts) that builds the
// training tensors AND the live inference policy (src/core/ml/policy.ts), so the
// exact same numbers are produced at train time and at decision time. This is
// the whole point: it eliminates the train/inference feature-mismatch class of
// bugs.
//
// Everything is computed DETERMINISTICALLY from the existing hand evaluator
// (evaluateHand / HAND_CATEGORY) and a fixed-deck equity estimator (no Math.random),
// so encodeSpot(spot) is a pure function of `spot`.
// ============================================================

/** A normalized postflop decision point. Built identically from a CSV row
 * (offline) and from live GameState (engine). */
export interface Spot {
  holeCards: [CardId, CardId];
  board: CardId[]; // 3 (flop), 4 (turn), or 5 (river) cards
  street: 'flop' | 'turn' | 'river';
  heroPos: 'IP' | 'OOP';
  facingBet: boolean;
  /** toCall / pot (0 if not facing a bet). */
  toCallFrac: number;
  /** offered Bet|Raise size / pot (0 if none offered). */
  offeredSizeFrac: number;
  canCheck: boolean;
  canBet: boolean;
  canCall: boolean;
  canRaise: boolean;
  canFold: boolean;
  threeBetPot: boolean;
}

// ---- Feature layout (documented; order matters and is FROZEN) ----
// [0..8]   hero made-hand category one-hot (9): HIGH_CARD..STRAIGHT_FLUSH
// [9]      hero equity vs random (deterministic, 0..1)
// [10]     high card rank / 12
// [11]     low card rank / 12
// [12]     suited (0/1)
// [13]     pocket pair (0/1)
// [14]     both broadway (0/1)
// [15]     hole gap / 12   (rank distance between the two hole cards)
// [16]     board monotone (3+ one suit) (0/1)
// [17]     board two-tone (exactly 2 of a suit, no 3-flush) (0/1)
// [18]     board paired (0/1)
// [19]     max same-suit count on board / 5
// [20]     board connectedness: #adjacent rank steps among distinct ranks / 4
// [21]     top board rank / 12
// [22]     #broadway cards on board / 5
// [23..25] street one-hot (3): flop, turn, river
// [26]     position: 1 if IP else 0
// [27]     facingBet (0/1)
// [28]     toCallFrac (clamped 0..3)
// [29]     offeredSizeFrac (clamped 0..3)
// [30]     log(1+pot-proxy) -> we use log1p of (toCall+offered) frac; pot itself
//          is normalized away, so we encode log1p(offeredSizeFrac) as a soft size
//          signal that distinguishes tiny vs huge bets nonlinearly
// [31]     threeBetPot (0/1)
// [32..36] legal-action mask (5): fold, check, call, bet, raise
// --- richer card-derived structure (appended AFTER the mask so the mask offset
//     stays 32; these capture draws and pair-QUALITY the category+equity miss) ---
// [37]     flush draw (hero has 4 to a flush, cards still to come) (0/1)
// [38]     nut flush draw (flush draw holding the ace of that suit) (0/1)
// [39]     open-ended / double-gutshot straight draw (>=2 hero outs) (0/1)
// [40]     gutshot straight draw (exactly 1 hero out) (0/1)
// [41]     combo draw (flush draw + straight draw) (0/1)
// [42]     two overcards (no pair, both hole ranks above the top board card) (0/1)
// [43]     overpair (pocket pair higher than the top board card) (0/1)
// [44]     top pair (a hole card pairs the top board rank) (0/1)
// [45]     second pair or worse / underpair (0/1)
// [46]     pair kicker rank / 12 (when holding one pair via a hole card)
// [47]     # board cards out-ranking hero's pair / 5 (dominated-pair risk)
const CATEGORY_COUNT = 9; // HIGH_CARD(0) .. STRAIGHT_FLUSH(8)
export const FEATURE_DIM = 48;

// Indices of the 5-way legal-action mask inside the feature vector, exported so
// the trainer/policy can mask logits to legal actions using the SAME features.
export const ACTION_MASK_OFFSET = 32; // fold, check, call, bet, raise
export const NUM_ACTIONS = 5;
export const ACTIONS = ['fold', 'check', 'call', 'bet', 'raise'] as const;
export type ActionClass = (typeof ACTIONS)[number];

// --- Bet-SIZE head ---------------------------------------------------------
// A second classifier predicts a bet/raise SIZE bucket from the SAME 48 features.
// The action head only decides WHETHER to bet; the size head decides HOW BIG,
// trained on the solver's actual chosen size (chips / pot) from the data. Each
// bucket maps to a representative pot-fraction the engine sizes with. The data's
// sizes cluster ~0.66-0.9 pot (the old texture heuristic under-bet at 0.33-0.66),
// with small/overbet tails — these buckets cover that range.
export const SIZE_BUCKET_FRACS = [0.40, 0.66, 0.85, 1.25, 2.0] as const;
export const NUM_SIZE_BUCKETS = SIZE_BUCKET_FRACS.length;
const SIZE_EDGES = [0.53, 0.755, 1.05, 1.625]; // midpoints between the fracs
/** Map a raw size fraction (chips/pot) to its bucket index. */
export function sizeBucketOf(frac: number): number {
  for (let i = 0; i < SIZE_EDGES.length; i++) if (frac <= SIZE_EDGES[i]) return i;
  return SIZE_EDGES.length;
}

const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

/**
 * Deterministic equity-vs-random estimate using the SAME evaluator as the rest
 * of the codebase. NO RNG: it walks a fixed pseudo-random-but-deterministic
 * sequence of (villain combo, runout) tuples generated by a fixed-seed LCG, so
 * encodeSpot is a pure function of `spot` AND identical at train and inference.
 *
 * The sample budget is a fixed constant, making this O(1) per row (a few
 * hundred evaluator calls). River is computed exactly when the budget covers
 * all villain combos.
 */
const EQUITY_SAMPLES = 400; // fixed budget -> deterministic, fast, stable

function deterministicEquity(hole: [CardId, CardId], board: CardId[]): number {
  if (board.length < 3) {
    // Preflop-style: approximate with high-card strength (not used postflop, but
    // keep it defined & deterministic).
    const r1 = (hole[0] / 4) | 0;
    const r2 = (hole[1] / 4) | 0;
    return clamp(0.35 + (r1 + r2) / 48 + (r1 === r2 ? 0.1 : 0), 0, 1);
  }

  const known = [hole[0], hole[1], ...board];
  const deck = removeCards(createDeck(), known);
  const n = deck.length;
  const need = 5 - board.length; // board cards still to come

  let win = 0;
  let tie = 0;
  let total = 0;

  if (need === 0) {
    // River: exact — compare hero vs EVERY legal 2-card villain combo (~990).
    const heroRank = evaluateHand([hole[0], hole[1], ...board]);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const vr = evaluateHand([deck[i], deck[j], ...board]);
        if (heroRank > vr) win++;
        else if (heroRank === vr) tie++;
        total++;
      }
    }
    return total === 0 ? 0.5 : (win + tie * 0.5) / total;
  }

  // Turn / flop: deterministic fixed-seed sampling of villain combos + runouts.
  // LCG (Numerical Recipes constants) seeded from the board so different spots
  // get different—but reproducible—samples.
  let seed = 0x9e3779b9 >>> 0;
  for (const c of known) seed = (Math.imul(seed ^ c, 0x85ebca6b) + 1) >>> 0;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const pick = () => deck[(next() * n) | 0];

  for (let s = 0; s < EQUITY_SAMPLES; s++) {
    // villain 2 distinct cards
    const va = pick();
    let vb = pick();
    let guard = 0;
    while (vb === va && guard++ < 8) vb = pick();
    if (vb === va) continue;
    // runout cards (need 1 on turn, 2 on flop), distinct from villain + board
    const runout: CardId[] = [];
    let g2 = 0;
    while (runout.length < need && g2++ < 32) {
      const r = pick();
      if (r === va || r === vb || runout.includes(r)) continue;
      runout.push(r);
    }
    if (runout.length < need) continue;
    const full = [...board, ...runout];
    const heroRank = evaluateHand([hole[0], hole[1], ...full]);
    const vr = evaluateHand([va, vb, ...full]);
    if (heroRank > vr) win++;
    else if (heroRank === vr) tie++;
    total++;
  }
  return total === 0 ? 0.5 : (win + tie * 0.5) / total;
}

const rankOf = (c: CardId): number => (c / 4) | 0;
const suitOf = (c: CardId): number => c % 4;

interface HeroExtra {
  flushDraw: number; nutFlushDraw: number; oesd: number; gutshot: number; comboDraw: number;
  twoOvercards: number; overpair: number; topPair: number; secondPairPlus: number;
  pairKicker: number; overcardsToPair: number;
}

/**
 * Card-derived draw + pair-quality features (pure function of hole + board).
 * The made-hand category one-hot (f0..8) and the equity scalar (f9) miss two
 * strategically decisive things: (1) a strong flush/straight DRAW reads as
 * "high card" with middling equity, and (2) the PAIR category doesn't say whether
 * it's an overpair, top pair, or a dominated bottom pair. These play completely
 * differently (semi-bluff vs value vs pot-control), so we encode them explicitly.
 */
function heroExtraFeatures(hole: [CardId, CardId], board: CardId[]): HeroExtra {
  const z: HeroExtra = {
    flushDraw: 0, nutFlushDraw: 0, oesd: 0, gutshot: 0, comboDraw: 0,
    twoOvercards: 0, overpair: 0, topPair: 0, secondPairPlus: 0, pairKicker: 0, overcardsToPair: 0,
  };
  if (board.length < 3) return z;
  const hr = [rankOf(hole[0]), rankOf(hole[1])];
  const hs = [suitOf(hole[0]), suitOf(hole[1])];
  const br = board.map(rankOf);
  const bs = board.map(suitOf);
  const topBoard = Math.max(...br);
  const toCome = 5 - board.length;
  const cat = Math.floor(evaluateHand([hole[0], hole[1], ...board]) / 1_000_000);

  // Flush draw: a suit where hero contributes and hole+board total exactly 4.
  if (toCome > 0 && cat < HAND_CATEGORY.FLUSH) {
    for (let s = 0; s < 4; s++) {
      const holeS = hs.filter(x => x === s).length;
      const boardS = bs.filter(x => x === s).length;
      if (holeS >= 1 && holeS + boardS === 4) {
        z.flushDraw = 1;
        if (hr.some((r, i) => hs[i] === s && r === 12)) z.nutFlushDraw = 1; // ace of suit
      }
    }
  }

  // Straight-draw outs that USE a hero card (so it's hero's draw, not the board's).
  if (toCome > 0 && cat < HAND_CATEGORY.STRAIGHT) {
    const present = new Set<number>([...hr, ...br]);
    const holeSet = new Set<number>(hr);
    const has = (r: number) => (r === -1 ? present.has(12) : present.has(r));
    const holeHas = (r: number) => (r === -1 ? holeSet.has(12) : holeSet.has(r));
    let outs = 0;
    for (let o = 0; o < 13; o++) {
      if (present.has(o)) continue;
      present.add(o);
      let found = false;
      for (let lo = -1; lo <= 8 && !found; lo++) {
        let ok = true, usesHole = false, usesOut = false;
        for (let k = 0; k < 5; k++) {
          const r = lo + k;
          if (!has(r)) { ok = false; break; }
          if (r === o) usesOut = true;
          if (holeHas(r)) usesHole = true;
        }
        if (ok && usesOut && usesHole) found = true;
      }
      present.delete(o);
      if (found) outs++;
    }
    if (outs >= 2) z.oesd = 1; else if (outs === 1) z.gutshot = 1;
  }
  z.comboDraw = z.flushDraw && (z.oesd || z.gutshot) ? 1 : 0;

  // Pair quality.
  const pocket = hr[0] === hr[1];
  if (cat === HAND_CATEGORY.PAIR) {
    if (pocket) {
      if (hr[0] > topBoard) z.overpair = 1; else z.secondPairPlus = 1;
    } else {
      const matched = hr.find(r => br.includes(r));
      const kicker = hr.find(r => !br.includes(r));
      if (matched === topBoard) z.topPair = 1; else z.secondPairPlus = 1;
      if (kicker !== undefined) z.pairKicker = kicker / 12;
      if (matched !== undefined) z.overcardsToPair = br.filter(r => r > matched).length / 5;
    }
  } else if (cat === HAND_CATEGORY.HIGH_CARD && !pocket && Math.min(hr[0], hr[1]) > topBoard) {
    z.twoOvercards = 1;
  }
  return z;
}

/**
 * Encode a normalized Spot into a fixed-length Float32Array feature vector.
 * Pure & deterministic — identical at training prep and live inference.
 */
export function encodeSpot(spot: Spot): Float32Array {
  const f = new Float32Array(FEATURE_DIM);
  const [c1, c2] = spot.holeCards;
  const r1 = (c1 / 4) | 0;
  const r2 = (c2 / 4) | 0;
  const s1 = c1 % 4;
  const s2 = c2 % 4;
  const high = Math.max(r1, r2);
  const low = Math.min(r1, r2);

  // --- Hero made-hand category (one-hot over 9) ---
  // Need at least 5 cards (2 hole + 3 board) for the evaluator.
  let heroCat: number = HAND_CATEGORY.HIGH_CARD;
  if (spot.board.length >= 3) {
    const rank = evaluateHand([c1, c2, ...spot.board]);
    heroCat = Math.floor(rank / 1_000_000);
  }
  for (let i = 0; i < CATEGORY_COUNT; i++) f[i] = heroCat === i ? 1 : 0;

  // --- Equity vs random (deterministic) ---
  f[9] = deterministicEquity(spot.holeCards, spot.board);

  // --- Hole-card features ---
  f[10] = high / 12;
  f[11] = low / 12;
  f[12] = s1 === s2 ? 1 : 0;
  f[13] = r1 === r2 ? 1 : 0;
  f[14] = high >= 8 && low >= 8 ? 1 : 0; // both broadway (T..A)
  f[15] = (high - low) / 12;

  // --- Board texture ---
  const suitCounts = [0, 0, 0, 0];
  const rankCounts = new Map<number, number>();
  for (const c of spot.board) {
    suitCounts[c % 4]++;
    const r = (c / 4) | 0;
    rankCounts.set(r, (rankCounts.get(r) || 0) + 1);
  }
  const maxSuit = Math.max(0, ...suitCounts);
  const monotone = maxSuit >= 3 ? 1 : 0;
  const twoTone = maxSuit === 2 ? 1 : 0;
  const paired = [...rankCounts.values()].some(v => v >= 2) ? 1 : 0;
  f[16] = monotone;
  f[17] = twoTone;
  f[18] = paired;
  f[19] = spot.board.length ? maxSuit / 5 : 0;

  // connectedness: count adjacent steps among DISTINCT sorted ranks
  const distinct = [...rankCounts.keys()].sort((a, b) => a - b);
  let steps = 0;
  for (let i = 1; i < distinct.length; i++) {
    if (distinct[i] - distinct[i - 1] === 1) steps++;
  }
  f[20] = steps / 4;
  const topRank = distinct.length ? distinct[distinct.length - 1] : 0;
  f[21] = topRank / 12;
  let broadwayOnBoard = 0;
  for (const c of spot.board) if (((c / 4) | 0) >= 8) broadwayOnBoard++;
  f[22] = broadwayOnBoard / 5;

  // --- Street one-hot ---
  f[23] = spot.street === 'flop' ? 1 : 0;
  f[24] = spot.street === 'turn' ? 1 : 0;
  f[25] = spot.street === 'river' ? 1 : 0;

  // --- Position / betting context ---
  f[26] = spot.heroPos === 'IP' ? 1 : 0;
  f[27] = spot.facingBet ? 1 : 0;
  f[28] = clamp(spot.toCallFrac, 0, 3);
  f[29] = clamp(spot.offeredSizeFrac, 0, 3);
  f[30] = Math.log1p(clamp(spot.offeredSizeFrac, 0, 3));
  f[31] = spot.threeBetPot ? 1 : 0;

  // --- Legal-action mask (5) ---
  f[ACTION_MASK_OFFSET + 0] = spot.canFold ? 1 : 0;
  f[ACTION_MASK_OFFSET + 1] = spot.canCheck ? 1 : 0;
  f[ACTION_MASK_OFFSET + 2] = spot.canCall ? 1 : 0;
  f[ACTION_MASK_OFFSET + 3] = spot.canBet ? 1 : 0;
  f[ACTION_MASK_OFFSET + 4] = spot.canRaise ? 1 : 0;

  // --- richer card-derived draw + pair-quality features (37..47) ---
  const hx = heroExtraFeatures(spot.holeCards, spot.board);
  f[37] = hx.flushDraw;
  f[38] = hx.nutFlushDraw;
  f[39] = hx.oesd;
  f[40] = hx.gutshot;
  f[41] = hx.comboDraw;
  f[42] = hx.twoOvercards;
  f[43] = hx.overpair;
  f[44] = hx.topPair;
  f[45] = hx.secondPairPlus;
  f[46] = hx.pairKicker;
  f[47] = hx.overcardsToPair;

  return f;
}

/** Extract the [fold,check,call,bet,raise] legal mask back out of a feature row. */
export function legalMaskFromFeatures(f: Float32Array | number[], offset = 0): number[] {
  const o = offset + ACTION_MASK_OFFSET;
  return [f[o], f[o + 1], f[o + 2], f[o + 3], f[o + 4]];
}
