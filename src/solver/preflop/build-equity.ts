/**
 * CLI: (re)compute and cache the 169x169 all-in equity matrix.
 *   PATH=/opt/homebrew/bin:$PATH npm run solve:equity
 */
import { equityMatrix } from './equity-matrix';
import { nameToIndex } from './categories';

const boards = Number(process.env.EQ_BOARDS ?? 250);
console.log(`Computing equity matrix (${boards} boards/pair)...`);
const t0 = Date.now();
const m = equityMatrix({
  boardsPerPair: boards,
  forceRecompute: true,
  onProgress: (f) => {
    const p = Math.round(f * 100);
    if (p % 10 === 0) process.stderr.write(`  ${p}%\n`);
  },
});
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
const eq = (a: string, b: string) => (m[nameToIndex(a)][nameToIndex(b)] * 100).toFixed(1) + '%';
console.log('Spot checks (known approximate values):');
console.log(`  AA vs KK  ~82.4%: ${eq('AA', 'KK')}`);
console.log(`  AA vs 72o ~87.1%: ${eq('AA', '72o')}`);
console.log(`  AKs vs 22 ~50.4%: ${eq('AKs', '22')}`);
console.log(`  AKo vs QQ ~43.0%: ${eq('AKo', 'QQ')}`);
