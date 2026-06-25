/**
 * ml/build-fixtures.ts — build the COMMITTED held-out fixture for ml-accuracy.test.ts.
 *
 * Reads ml/data/postflop_test.csv (gitignored 10k held-out solver-labeled rows),
 * reuses the EXACT prep.ts parsing logic (splitCsv + parseRow) to turn each row
 * into a normalized Spot + correct-action class, deterministically samples ~2000
 * of them, and writes tests/fixtures/postflop-holdout.json.
 *
 * The fixture stores the *Spot* and *label* only (not pre-encoded features), so
 * the test exercises the real committed encodeSpot() at run time. This keeps the
 * accuracy claim reproducible in CI without the raw dataset.
 *
 * Run:  npx tsx ml/build-fixtures.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { splitCsv, parseRow, Parsed } from './prep';

const CSV = path.join(__dirname, 'data', 'postflop_test.csv');
const OUT = path.join(__dirname, '..', 'tests', 'fixtures', 'postflop-holdout.json');
const SAMPLE = 2000;

function main(): void {
  if (!fs.existsSync(CSV)) {
    console.error(`missing ${CSV}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter(l => l.trim());
  const headerCols = splitCsv(lines[0]);
  const header: Record<string, number> = {};
  headerCols.forEach((name, i) => { header[name.trim()] = i; });

  const parsed: Parsed[] = [];
  for (let i = 1; i < lines.length; i++) {
    const p = parseRow(splitCsv(lines[i]), header);
    if (p) parsed.push(p);
  }
  console.log(`parsed ${parsed.length}/${lines.length - 1} rows`);

  // Deterministic stride sampling across the whole file (no RNG) -> reproducible,
  // and representative of the full distribution rather than a contiguous block.
  const stride = Math.max(1, Math.floor(parsed.length / SAMPLE));
  const sampled: Parsed[] = [];
  for (let i = 0; i < parsed.length && sampled.length < SAMPLE; i += stride) {
    sampled.push(parsed[i]);
  }

  const fixture = sampled.map(p => ({
    holeCards: p.spot.holeCards,
    board: p.spot.board,
    street: p.spot.street,
    heroPos: p.spot.heroPos,
    facingBet: p.spot.facingBet,
    toCallFrac: p.spot.toCallFrac,
    offeredSizeFrac: p.spot.offeredSizeFrac,
    canCheck: p.spot.canCheck,
    canBet: p.spot.canBet,
    canCall: p.spot.canCall,
    canRaise: p.spot.canRaise,
    canFold: p.spot.canFold,
    threeBetPot: p.spot.threeBetPot,
    label: p.label,
  }));

  const dist = [0, 0, 0, 0, 0];
  for (const f of fixture) dist[f.label]++;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(fixture));
  const size = fs.statSync(OUT).size;
  console.log(`wrote ${OUT} — ${fixture.length} spots, ${(size / 1024).toFixed(0)} KiB`);
  console.log(`class dist [fold,check,call,bet,raise] = ${dist.join(', ')}`);
}

main();
