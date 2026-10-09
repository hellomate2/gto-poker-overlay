// ============================================================
// Session statistics for human-vs-bot play.
//
// Every hand gives one sample: the human's net in big blinds. bb/100 is
// 100 * mean, and the 95% interval is mean +/- t(0.975, n-1) * sd / sqrt(n),
// scaled by 100. The Student t quantile (not the normal 1.96) is used because a
// human session is tens or hundreds of hands, where 1.96 would understate the
// width. The t quantile is computed from the t CDF (regularized incomplete
// beta) by bisection, so there is no hard-coded table to get wrong.
//
// Caveat shown in the UI: poker results per hand are heavy-tailed (a few
// stacked pots dominate), so the interval is an approximation that gets better
// with more hands. The all-in adjusted series (allin-ev.ts) removes the
// run-out luck of all-in pots and usually narrows it.
// ============================================================

/** log Gamma via the Lanczos approximation (g = 7, n = 9). */
function lgamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta (modified Lentz). */
function betacf(a: number, b: number, x: number): number {
  const TINY = 1e-300;
  let c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}

/** Student t CDF with `df` degrees of freedom. */
export function tCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const tail = 0.5 * incBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** Student t quantile, by bisection on tCdf (p in (0.5, 1)). */
export function tQuantile(p: number, df: number): number {
  if (!(p > 0.5 && p < 1)) throw new Error('tQuantile: p must be in (0.5, 1)');
  let lo = 0, hi = 1;
  while (tCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface RateCI {
  /** Samples (hands). */
  n: number;
  /** Sum of the samples, in bb. */
  total: number;
  /** 100 * mean, i.e. bb per 100 hands. */
  bb100: number;
  /** Half-width of the 95% interval on bb100; null with fewer than 2 hands. */
  ci95: number | null;
  /** Sample standard deviation per hand, bb; null with fewer than 2 hands. */
  sdPerHand: number | null;
}

/** bb/100 with a Student-t 95% interval from per-hand bb results. */
export function bb100CI(perHandBb: readonly number[]): RateCI {
  const n = perHandBb.length;
  const total = perHandBb.reduce((a, b) => a + b, 0);
  if (n === 0) return { n, total: 0, bb100: 0, ci95: null, sdPerHand: null };
  const mean = total / n;
  if (n < 2) return { n, total, bb100: 100 * mean, ci95: null, sdPerHand: null };
  let ss = 0;
  for (const x of perHandBb) ss += (x - mean) * (x - mean);
  const sd = Math.sqrt(ss / (n - 1));
  const half = tQuantile(0.975, n - 1) * sd / Math.sqrt(n);
  return { n, total, bb100: 100 * mean, ci95: 100 * half, sdPerHand: sd };
}
