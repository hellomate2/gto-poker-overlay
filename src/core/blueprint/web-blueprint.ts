// ============================================================
// The trained blueprint, fully in the browser (no `bp serve`).
//
// Assets (written by blueprint/scripts/export-web.ts into blueprint/web/,
// copied to dist/blueprint/ by the webpack build):
//   meta.json        format, abstraction id, file names and raw sizes
//   policy.gpobp.gz  `bp export` output (tree + average strategy quantized to
//                    bytes summing to 255 per infoset), gzipped
//   flop.u8.gz       flop bucket per [canonical flop][combo], one byte
//   turn.u8.gz       turn bucket per [canonical turn][combo], one byte
//   boards.u32.gz    canonical flop keys then canonical turn keys (uint32 LE)
// River buckets are computed per decision (web-tables.ts).
//
// This module does no I/O: the caller passes a reader that returns the
// decompressed bytes of each file (web-assets.ts has the browser and Node
// readers).
// ============================================================

import { Card } from '../../types/poker';
import { cardToId } from '../cfr/card-utils';
import { Blueprint, NODE_DECISION } from './loader';
import { BucketTables } from './web-tables';
import { PolicyAnswer, PolicySource } from './agent';
import { TreeRules, parseTreeDescription } from './abstract-tree';

export const WEB_FORMAT = 'gpo-blueprint-web';
export const WEB_VERSION = 1;

export interface WebFileInfo {
  file: string;
  /** Size after decompression. */
  bytes: number;
}

export interface WebMeta {
  format: string;
  version: number;
  abstraction: { id: string; buckets: number[] };
  iterations: number;
  tree_config: string;
  files: {
    policy: WebFileInfo;
    flop: WebFileInfo & { boards: number };
    turn: WebFileInfo & { boards: number };
    boards: WebFileInfo;
  };
  [k: string]: unknown;
}

/** Returns the bytes of an asset file; `.gz` files come back decompressed. */
export type AssetReader = (file: string) => Promise<Uint8Array>;

export interface WebBlueprint {
  meta: WebMeta;
  blueprint: Blueprint;
  tables: BucketTables;
  rules: TreeRules;
  source: PolicySource & { lookup: WebPolicySource['lookup'] };
}

export async function loadWebBlueprint(read: AssetReader): Promise<WebBlueprint> {
  const meta = JSON.parse(new TextDecoder().decode(await read('meta.json'))) as WebMeta;
  if (meta.format !== WEB_FORMAT || meta.version !== WEB_VERSION) {
    throw new Error(`blueprint web: unsupported assets ${meta.format} v${meta.version}`);
  }
  const f = meta.files;
  const [policy, flop, turn, boards] = await Promise.all([
    read(f.policy.file), read(f.flop.file), read(f.turn.file), read(f.boards.file),
  ]);
  for (const [name, info, got] of [
    ['policy', f.policy, policy], ['flop', f.flop, flop], ['turn', f.turn, turn], ['boards', f.boards, boards],
  ] as const) {
    if (got.byteLength !== info.bytes) throw new Error(`blueprint web: ${name} has ${got.byteLength} bytes, expected ${info.bytes}`);
  }
  const blueprint = Blueprint.parse(policy);
  const h = blueprint.header;
  if (h.abstraction?.id !== meta.abstraction.id) {
    throw new Error(`blueprint web: policy abstraction ${h.abstraction?.id} vs tables ${meta.abstraction.id}`);
  }
  if (h.buckets.join(',') !== meta.abstraction.buckets.join(',')) throw new Error('blueprint web: bucket counts differ');
  const nf = f.flop.boards, nt = f.turn.boards;
  if (boards.byteLength !== 4 * (nf + nt)) throw new Error('blueprint web: board key list size');
  const keys = new Uint32Array(nf + nt);
  const dv = new DataView(boards.buffer, boards.byteOffset, boards.byteLength);
  for (let i = 0; i < nf + nt; i++) keys[i] = dv.getUint32(4 * i, true);
  const tables = new BucketTables({
    flop, turn, flopKeys: keys.subarray(0, nf), turnKeys: keys.subarray(nf),
    riverBounds: h.abstraction?.river_bounds ?? [], buckets: h.buckets,
  });
  const rules = parseTreeDescription(h.tree_config);
  return { meta, blueprint, tables, rules, source: new WebPolicySource(blueprint, tables) };
}

/** PolicySource for BlueprintAgent over the loaded assets. */
export class WebPolicySource implements PolicySource {
  constructor(private readonly bp: Blueprint, private readonly tables: BucketTables) {}

  /** Synchronous lookup on card ids; throws on an unknown history or bad cards. */
  lookup(history: readonly string[], hole: readonly [number, number], board: readonly number[]): PolicyAnswer & { node: number; street: number; player: number; visited: boolean } {
    const node = this.bp.findNode(history);
    if (node < 0) throw new Error(`blueprint web: history not in tree: ${history.join(' ')}`);
    const n = this.bp.node(node);
    if (n.type !== NODE_DECISION) throw new Error(`blueprint web: history ends at a terminal: ${history.join(' ')}`);
    const street = board.length === 0 ? 0 : board.length - 2;
    if (street !== n.street) throw new Error(`blueprint web: board of ${board.length} cards at a street ${n.street} node`);
    const bucket = this.tables.bucket(hole, board);
    const { probs, visited } = this.bp.strategyAt(node, bucket);
    const toks = this.bp.children(node).map(c => c.token);
    return { toks, probs, bucket, node, street: n.street, player: n.player, visited };
  }

  async policy(history: readonly string[], hole: readonly [Card, Card], board: readonly Card[]): Promise<PolicyAnswer> {
    return this.lookup(history, [cardToId(hole[0]), cardToId(hole[1])], board.map(cardToId));
  }
}
