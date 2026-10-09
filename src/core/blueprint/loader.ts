import { CardId } from '../../types/poker';
import { evaluateHand } from '../equity/hand-eval';

// ============================================================
// Blueprint policy loader.
//
// Reads the compact policy file written by the offline C++ trainer
// (`blueprint/bin/bp export`, format documented in blueprint/src/export.h and
// blueprint/README.md) and answers "what does the blueprint do at this
// abstracted infoset?".
//
// An abstracted infoset is (betting history, card bucket):
//   * history: action tokens from the root of the abstract betting tree, e.g.
//     ['r0.5', 'c', 'k', 'b1']. Tokens: f fold, k check, c call,
//     b<frac> bet, r<frac> raise (fractions of the pot, e.g. b0.5, r1),
//     a all-in. Limit games (Kuhn/Leduc exports) use bare 'b' / 'r'.
//   * bucket: the acting player's card bucket on the current street.
//     Preflop it is preflopClass(card1, card2) (169 lossless classes).
//     River buckets: riverEhs(hole, board) then riverBucketFromEhs() with
//     the river_bounds stored in the header (or Blueprint.riverBucket()). Flop/turn buckets come from the
//     trainer's k-means tables (blueprint/cache/abs-*.bin), which this
//     module does not load.
//
// Player 0 is the small blind / button (first to act preflop, last
// postflop); player 1 is the big blind.
//
// This module only reads data. It does no I/O, so it runs in Node tests and
// in the browser alike; the caller supplies the bytes.
// ============================================================

export const NODE_DECISION = 0;
export const NODE_FOLD = 1;
export const NODE_SHOWDOWN = 2;

export const ACTION_KINDS = ['root', 'fold', 'check', 'call', 'bet', 'raise', 'allin'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

const MAGIC = 'GPOBP001';
const NO_STRATEGY = 0xffffffff;

export interface BlueprintHeader {
  format: string;
  version: number;
  game: string;
  tree_config: string;
  streets: number;
  buckets: number[];
  stack: number;
  blinds: [number, number];
  min_bet: number;
  num_nodes: number;
  num_slots: number;
  node_record_bytes: number;
  nodes_offset: number;
  strategy_offset: number;
  action_kinds: string[];
  iterations?: number;
  abstraction?: { id?: string; river_bounds?: number[]; [k: string]: unknown };
  [k: string]: unknown;
}

export interface BlueprintNode {
  index: number;
  type: number;
  /** Actor at a decision node; the folding player at a fold node. */
  player: number;
  street: number;
  nact: number;
  /** Kind of the action that led INTO this node. */
  actKind: ActionKind;
  raises: number;
  /** Pot fraction x1000 of the bet/raise that led here (0 otherwise). */
  fracMilli: number;
  child: number;
  parent: number;
  /** Byte offset of bucket 0 in the strategy section, or -1 for terminals. */
  strategyOffset: number;
  /** Chips committed by [player0, player1] after the action. */
  contrib: [number, number];
}

export interface AbstractInfoset {
  history: string[];
  bucket: number;
}

export interface StrategyLookup {
  node: number;
  street: number;
  player: number;
  /** Tokens of the legal abstract actions, in strategy order. */
  actions: string[];
  probs: number[];
  /** False when training never reached this infoset; probs are then uniform. */
  visited: boolean;
}

export class Blueprint {
  readonly header: BlueprintHeader;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly limitStreet: boolean[];

  private constructor(bytes: Uint8Array, header: BlueprintHeader) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.header = header;
    // Limit streets print bare 'b'/'r' tokens. The C++ side writes each
    // street as "s<i>:...,limit=<size>" in tree_config for limit rules.
    this.limitStreet = [];
    for (let s = 0; s < header.streets; s++) {
      const seg = header.tree_config.split(';').find((x) => x.startsWith(`s${s}:`)) ?? '';
      this.limitStreet.push(/(^|,)limit=/.test(seg.slice(seg.indexOf(':') + 1)));
    }
  }

  /** Parse a policy file. Throws on a malformed or truncated buffer. */
  static parse(data: ArrayBuffer | Uint8Array): Blueprint {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.byteLength < 12) throw new Error('blueprint: file too small');
    const magic = String.fromCharCode(...bytes.subarray(0, 8));
    if (magic !== MAGIC) throw new Error(`blueprint: bad magic ${JSON.stringify(magic)}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const hlen = view.getUint32(8, true);
    if (12 + hlen > bytes.byteLength) throw new Error('blueprint: truncated header');
    const header = JSON.parse(
      new TextDecoder().decode(bytes.subarray(12, 12 + hlen)),
    ) as BlueprintHeader;
    if (header.format !== 'gpo-blueprint' || header.version !== 1) {
      throw new Error(`blueprint: unsupported format ${header.format} v${header.version}`);
    }
    const end = header.strategy_offset + header.num_slots;
    const nodesEnd = header.nodes_offset + header.num_nodes * header.node_record_bytes;
    if (nodesEnd > header.strategy_offset || end > bytes.byteLength) {
      throw new Error('blueprint: truncated body');
    }
    return new Blueprint(bytes, header);
  }

  get numNodes(): number {
    return this.header.num_nodes;
  }

  node(i: number): BlueprintNode {
    if (i < 0 || i >= this.header.num_nodes)
      throw new RangeError(`blueprint: node ${i} out of range`);
    const o = this.header.nodes_offset + i * this.header.node_record_bytes;
    const v = this.view;
    const off = v.getUint32(o + 16, true);
    return {
      index: i,
      type: v.getUint8(o),
      player: v.getUint8(o + 1),
      street: v.getUint8(o + 2),
      nact: v.getUint8(o + 3),
      actKind: ACTION_KINDS[v.getUint8(o + 4)] ?? 'root',
      raises: v.getUint8(o + 5),
      fracMilli: v.getUint16(o + 6, true),
      child: v.getUint32(o + 8, true),
      parent: v.getUint32(o + 12, true),
      strategyOffset: off === NO_STRATEGY ? -1 : off,
      contrib: [v.getInt32(o + 20, true), v.getInt32(o + 24, true)],
    };
  }

  /** Token of the action that led into node i (same spelling as the C++ side). */
  token(i: number): string {
    const n = this.node(i);
    switch (n.actKind) {
      case 'fold':
        return 'f';
      case 'check':
        return 'k';
      case 'call':
        return 'c';
      case 'allin':
        return 'a';
      case 'bet':
      case 'raise': {
        const letter = n.actKind === 'bet' ? 'b' : 'r';
        const parentStreet = this.node(n.parent).street;
        // String(x) matches C's %g for the 3-decimal fractions we store.
        return this.limitStreet[parentStreet] ? letter : `${letter}${String(n.fracMilli / 1000)}`;
      }
      default:
        return '';
    }
  }

  /** Tokens from the root to node i. */
  history(i: number): string[] {
    const out: string[] = [];
    while (i !== 0) {
      out.push(this.token(i));
      i = this.node(i).parent;
    }
    return out.reverse();
  }

  children(i: number): { token: string; node: number }[] {
    const n = this.node(i);
    if (n.type !== NODE_DECISION) return [];
    const out: { token: string; node: number }[] = [];
    for (let a = 0; a < n.nact; a++)
      out.push({ token: this.token(n.child + a), node: n.child + a });
    return out;
  }

  /** Follow a token history from the root; -1 if any token is not in the tree. */
  findNode(history: readonly string[]): number {
    let cur = 0;
    for (const tok of history) {
      const next = this.children(cur).find((c) => c.token === tok);
      if (!next) return -1;
      cur = next.node;
    }
    return cur;
  }

  /** Strategy at (decision node, bucket). Unvisited infosets come back uniform. */
  strategyAt(nodeIndex: number, bucket: number): { probs: number[]; visited: boolean } {
    const n = this.node(nodeIndex);
    if (n.type !== NODE_DECISION) throw new Error(`blueprint: node ${nodeIndex} is terminal`);
    const nb = this.header.buckets[n.street];
    if (!Number.isInteger(bucket) || bucket < 0 || bucket >= nb) {
      throw new RangeError(
        `blueprint: bucket ${bucket} out of range for street ${n.street} (${nb} buckets)`,
      );
    }
    const base = this.header.strategy_offset + n.strategyOffset + bucket * n.nact;
    const raw = this.bytes.subarray(base, base + n.nact);
    let sum = 0;
    for (const b of raw) sum += b;
    if (sum === 0) return { probs: new Array(n.nact).fill(1 / n.nact), visited: false };
    return { probs: Array.from(raw, (b) => b / sum), visited: true };
  }

  /** Strategy for an abstracted infoset, or null if the history is not a decision point. */
  lookup(infoset: AbstractInfoset): StrategyLookup | null {
    const idx = this.findNode(infoset.history);
    if (idx < 0) return null;
    const n = this.node(idx);
    if (n.type !== NODE_DECISION) return null;
    const { probs, visited } = this.strategyAt(idx, infoset.bucket);
    return {
      node: idx,
      street: n.street,
      player: n.player,
      actions: this.children(idx).map((c) => c.token),
      probs,
      visited,
    };
  }

  /** Canonical string key for an infoset: "<tokens space-separated>|<bucket>". */
  static infosetKey(infoset: AbstractInfoset): string {
    return `${infoset.history.join(' ')}|${infoset.bucket}`;
  }

  lookupKey(key: string): StrategyLookup | null {
    const bar = key.lastIndexOf('|');
    if (bar < 0) return null;
    const hist = key.slice(0, bar).trim();
    const bucket = Number(key.slice(bar + 1));
    return this.lookup({ history: hist ? hist.split(/\s+/) : [], bucket });
  }

  /** River bucket for a hand's EHS, using the bounds stored in the header. */
  riverBucket(ehs: number): number {
    const bounds = this.header.abstraction?.river_bounds;
    if (!bounds) throw new Error('blueprint: header has no river_bounds');
    return riverBucketFromEhs(ehs, bounds);
  }
}

/**
 * Lossless preflop class 0..168, identical to blueprint/src/abstraction.h:
 * ranks 0..12 (2..A) on a 13x13 grid; pairs (r, r), suited (row = high,
 * col = low), offsuit (row = low, col = high); index = row * 13 + col.
 */
export function preflopClass(a: CardId, b: CardId): number {
  const ra = a >> 2;
  const rb = b >> 2;
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  if (hi === lo) return hi * 13 + hi;
  if ((a & 3) === (b & 3)) return hi * 13 + lo;
  return lo * 13 + hi;
}

/** Number of bounds <= ehs (std::upper_bound), matching Abstraction::river_from_ehs. */
export function riverBucketFromEhs(ehs: number, bounds: readonly number[]): number {
  let lo = 0;
  let hi = bounds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bounds[mid] <= ehs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * River expected hand strength exactly as the trainer defines it: the share
 * of the 990 opponent holdings (all 2-card combos disjoint from hero and
 * board) that hero beats, ties counting half.
 */
export function riverEhs(hole: readonly [CardId, CardId], board: readonly CardId[]): number {
  if (board.length !== 5) throw new Error('riverEhs: board must have 5 cards');
  const dead = new Set<CardId>([...hole, ...board]);
  if (dead.size !== 7) throw new Error('riverEhs: duplicate cards');
  const mine = evaluateHand([...hole, ...board]);
  let score = 0;
  let n = 0;
  for (let a = 0; a < 52; a++) {
    if (dead.has(a)) continue;
    for (let b = a + 1; b < 52; b++) {
      if (dead.has(b)) continue;
      const theirs = evaluateHand([a, b, ...board]);
      score += mine > theirs ? 1 : mine === theirs ? 0.5 : 0;
      n++;
    }
  }
  return score / n;
}
