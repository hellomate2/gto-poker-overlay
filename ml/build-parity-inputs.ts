/**
 * ml/build-parity-inputs.ts — produce the fixed RAW feature vectors used by the
 * parity test. Encodes a diverse, hand-built set of Spots through the COMMITTED
 * encodeSpot(), and also pulls a few real spots from the holdout fixture, then
 * writes the resulting Float32 vectors (as plain number arrays) to
 * tests/fixtures/parity-inputs.json.
 *
 * Both ml/parity-gen.py (numpy reference) and tests/ml-parity.test.ts (TS forward
 * pass) consume these identical raw vectors, so the comparison is apples-to-apples.
 *
 * Run:  npx tsx ml/build-parity-inputs.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { encodeSpot, Spot } from '../src/core/ml/features';
import { parseCard, cardToId } from '../src/core/cfr/card-utils';

const id = (s: string) => cardToId(parseCard(s));
const OUT = path.join(__dirname, '..', 'tests', 'fixtures', 'parity-inputs.json');

function base(p: Partial<Spot>): Spot {
  return {
    holeCards: [id('Ah'), id('Kh')],
    board: [id('Ks'), id('7h'), id('2d')],
    street: 'flop',
    heroPos: 'IP',
    facingBet: false,
    toCallFrac: 0,
    offeredSizeFrac: 0.66,
    canCheck: true, canBet: true, canCall: false, canRaise: false, canFold: false,
    threeBetPot: false,
    ...p,
  };
}

const spots: Spot[] = [
  base({}),
  base({ heroPos: 'OOP' }),
  base({ street: 'turn', board: [id('Ks'), id('7h'), id('2d'), id('Jc')] }),
  base({ street: 'river', board: [id('Ks'), id('7h'), id('2d'), id('Jc'), id('7c')] }),
  base({
    holeCards: [id('2c'), id('7d')],
    facingBet: true, toCallFrac: 0.5, offeredSizeFrac: 0.5,
    canCheck: false, canBet: false, canCall: true, canRaise: true, canFold: true,
  }),
  base({
    holeCards: [id('As'), id('Ad')], street: 'river',
    board: [id('Ac'), id('Kd'), id('5s'), id('9h'), id('2c')],
    threeBetPot: true,
  }),
  base({
    holeCards: [id('Qh'), id('Jh')], street: 'flop',
    board: [id('Th'), id('9h'), id('2s')],
    facingBet: true, toCallFrac: 0.33, offeredSizeFrac: 0.33,
    canCheck: false, canBet: false, canCall: true, canRaise: true, canFold: true,
  }),
  base({
    holeCards: [id('8c'), id('8d')], street: 'turn',
    board: [id('Ks'), id('Qh'), id('5d'), id('2c')], heroPos: 'OOP',
    facingBet: true, toCallFrac: 1.2, offeredSizeFrac: 1.2,
    canCheck: false, canBet: false, canCall: true, canRaise: true, canFold: true,
  }),
];

// Plus a few real spots from the holdout, if present, for realism.
const fxPath = path.join(__dirname, '..', 'tests', 'fixtures', 'postflop-holdout.json');
if (fs.existsSync(fxPath)) {
  const fx = JSON.parse(fs.readFileSync(fxPath, 'utf8'));
  for (const i of [0, 250, 500, 1000, 1500, 1900]) {
    if (fx[i]) {
      const { label, ...spot } = fx[i];
      spots.push(spot as Spot);
    }
  }
}

const inputs = spots.map(s => Array.from(encodeSpot(s)));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(inputs));
console.log(`wrote ${OUT} — ${inputs.length} raw feature vectors`);
