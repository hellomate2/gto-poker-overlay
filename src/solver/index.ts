/**
 * Public surface of the CFR solver package.
 *
 * A self-contained, game-agnostic implementation of the Counterfactual Regret
 * Minimization algorithm family with two canonical benchmark games (Kuhn and
 * Leduc poker) and an exact best-response / exploitability calculator.
 */
export * from './game';
export * from './store';
export * from './rng';
export * from './cfr';
export * from './mccfr';
export * from './exploitability';
export { KuhnPoker } from './games/kuhn';
export type { KuhnHistory } from './games/kuhn';
export { LeducPoker } from './games/leduc';
export type { LeducHistory } from './games/leduc';
