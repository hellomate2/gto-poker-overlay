/**
 * ml/prep.ts — build training tensors from the PokerBench postflop CSVs.
 *
 * Streams each CSV row, parses it into a normalized `Spot` (the SAME structure
 * the live engine builds), calls the SHARED encodeSpot(), maps correct_decision
 * to one of 5 classes (0=fold,1=check,2=call,3=bet,4=raise), and writes flat
 * little-endian binary tensors:
 *   ml/data/{train,test}_X.f32   Float32, shape [N, FEATURE_DIM]
 *   ml/data/{train,test}_y.u8    Uint8,   shape [N]
 *   ml/data/{train,test}_shape.json  { n, dim }
 *
 * Run:  npx tsx ml/prep.ts
 */
import * as fs from 'fs';
import * as readline from 'readline';
import { parseCard, cardToId } from '../src/core/cfr/card-utils';
import { encodeSpot, Spot, FEATURE_DIM, ACTIONS } from '../src/core/ml/features';

const DATA = `${__dirname}/data`;

interface Parsed {
  spot: Spot;
  label: number;
}

/** Parse a card string like "Ks7h2d" into CardIds. */
function parseCards(s: string): number[] {
  const out: number[] = [];
  s = s.trim();
  for (let i = 0; i + 1 < s.length; i += 2) {
    out.push(cardToId(parseCard(s.slice(i, i + 2))));
  }
  return out;
}

/** Parse "['Fold', 'Call', 'Raise 84']" -> ['Fold','Call','Raise 84']. */
function parseMoves(s: string): string[] {
  const inner = s.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.trim()) return [];
  return inner
    .split(',')
    .map(x => x.trim().replace(/^'/, '').replace(/'$/, '').replace(/^"/, '').replace(/"$/, ''))
    .filter(Boolean);
}

/** Last BET_x / RAISE_x amount in the betting sequence (what hero faces). */
function lastWagerAmount(seq: string): number {
  const tokens = seq.split('/');
  for (let i = tokens.length - 1; i >= 0; i--) {
    const m = tokens[i].match(/(?:BET|RAISE)_(\d+(?:\.\d+)?)/);
    if (m) return parseFloat(m[1]);
  }
  return 0;
}

/** correct_decision -> class index, or -1 if unrecognized. */
function labelFor(decision: string): number {
  const t = decision.trim().split(/\s+/)[0].toLowerCase();
  const idx = ACTIONS.indexOf(t as any);
  return idx;
}

/**
 * Robust CSV line splitter for this dataset (quoted fields may contain commas,
 * e.g. the available_moves list). Handles double quotes only.
 */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseRow(cols: string[], header: Record<string, number>): Parsed | null {
  const get = (k: string) => cols[header[k]] ?? '';

  const evalAt = get('evaluation_at').trim();
  const street = evalAt.toLowerCase() as Spot['street'];
  if (street !== 'flop' && street !== 'turn' && street !== 'river') return null;

  // Board: flop always; turn/river appended when this street is reached.
  const flop = parseCards(get('board_flop'));
  if (flop.length !== 3) return null;
  let board = [...flop];
  if (street === 'turn' || street === 'river') {
    const t = parseCards(get('board_turn'));
    if (t.length !== 1) return null;
    board.push(t[0]);
  }
  if (street === 'river') {
    const r = parseCards(get('board_river'));
    if (r.length !== 1) return null;
    board.push(r[0]);
  }

  const holeStr = get('holding').trim();
  const hole = parseCards(holeStr);
  if (hole.length !== 2) return null;

  const heroPos = get('hero_position').trim() as 'IP' | 'OOP';
  if (heroPos !== 'IP' && heroPos !== 'OOP') return null;

  const pot = parseFloat(get('pot_size'));
  if (!isFinite(pot) || pot <= 0) return null;

  const moves = parseMoves(get('available_moves'));
  if (moves.length === 0) return null;
  const lower = moves.map(m => m.toLowerCase());
  const canFold = lower.some(m => m.startsWith('fold'));
  const canCheck = lower.some(m => m.startsWith('check'));
  const canCall = lower.some(m => m.startsWith('call'));
  const canBet = lower.some(m => m.startsWith('bet'));
  const canRaise = lower.some(m => m.startsWith('raise'));
  const facingBet = canCall || canFold; // you only fold/call when facing a wager

  // Offered bet/raise size from the available_moves (single offered size).
  let offeredSize = 0;
  for (const m of moves) {
    const mm = m.match(/^(?:Bet|Raise)\s+(\d+(?:\.\d+)?)/i);
    if (mm) { offeredSize = parseFloat(mm[1]); break; }
  }

  // Amount hero faces (to-call) when facing a bet: last BET_x/RAISE_x in seq.
  const seq = get('postflop_action');
  const toCall = facingBet ? lastWagerAmount(seq) : 0;

  const threeBetPot = /3bet|4bet|3-bet|4-bet/i.test(get('preflop_action')) ||
    (get('preflop_action').match(/call|bb/gi)?.length ?? 0) > 4;

  const label = labelFor(get('correct_decision'));
  if (label < 0) return null;

  const spot: Spot = {
    holeCards: [hole[0], hole[1]],
    board,
    street,
    heroPos,
    facingBet,
    toCallFrac: pot > 0 ? toCall / pot : 0,
    offeredSizeFrac: pot > 0 ? offeredSize / pot : 0,
    canCheck, canBet, canCall, canRaise, canFold,
    threeBetPot,
  };
  return { spot, label };
}

async function prep(split: 'train' | 'test'): Promise<void> {
  const override = process.env[`PREP_${split.toUpperCase()}_CSV`];
  const csv = override || `${DATA}/postflop_${split}.csv`;
  if (!fs.existsSync(csv)) { console.error(`missing ${csv}`); return; }

  const rl = readline.createInterface({ input: fs.createReadStream(csv), crlfDelay: Infinity });
  let header: Record<string, number> | null = null;

  const xs: Float32Array[] = [];
  const ys: number[] = [];
  let total = 0;
  let skipped = 0;
  const t0 = Date.now();

  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = splitCsv(line);
    if (!header) {
      header = {};
      cols.forEach((name, i) => { header![name.trim()] = i; });
      continue;
    }
    total++;
    try {
      const p = parseRow(cols, header);
      if (!p) { skipped++; continue; }
      xs.push(encodeSpot(p.spot));
      ys.push(p.label);
    } catch (e) {
      skipped++;
    }
    if (total % 50000 === 0) {
      console.log(`  ${split}: ${total} rows (${skipped} skipped) ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }

  const n = xs.length;
  const X = new Float32Array(n * FEATURE_DIM);
  const y = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    X.set(xs[i], i * FEATURE_DIM);
    y[i] = ys[i];
  }
  fs.writeFileSync(`${DATA}/${split}_X.f32`, Buffer.from(X.buffer));
  fs.writeFileSync(`${DATA}/${split}_y.u8`, Buffer.from(y.buffer));
  fs.writeFileSync(`${DATA}/${split}_shape.json`, JSON.stringify({ n, dim: FEATURE_DIM }));

  // Class distribution sanity.
  const dist = [0, 0, 0, 0, 0];
  for (const c of y) dist[c]++;
  console.log(`${split}: wrote ${n} rows (skipped ${skipped}/${total}). dim=${FEATURE_DIM}`);
  console.log(`  class dist [fold,check,call,bet,raise] = ${dist.join(', ')}`);
}

(async () => {
  await prep('train');
  await prep('test');
  console.log('prep done.');
})();
