/**
 * Canonical 169 preflop hand categories and their card combinations.
 *
 * A "category" is one of the 169 strategically-distinct starting hands in
 * Hold'em: 13 pocket pairs, 78 suited hands, 78 offsuit hands. The heads-up
 * preflop solver works at the category level (169 x 169) rather than the
 * 1326-combo level: this is the standard "range vs range" preflop abstraction
 * and keeps the game tree tractable while remaining accurate, because card
 * removal between two specific categories is small and is folded into the
 * combo-weighted leaf equities.
 *
 * Category index layout matches `handGroupIndex` in core/cfr/card-utils.ts:
 *   - indices 0..12   : pocket pairs (22 .. AA), index == high rank
 *   - indices 13..90  : suited      (13 + high*(high-1)/2 + low)
 *   - indices 91..168 : offsuit     (13 + 78 + high*(high-1)/2 + low)
 */
import { CardId } from '../../types/poker';
import { handGroupIndex, handGroupName } from '../../core/cfr/card-utils';

export const NUM_CATEGORIES = 169;

/** Combo count for a category by its kind. pair=6, suited=4, offsuit=12. */
export type Kind = 'pair' | 'suited' | 'offsuit';

export interface CategoryInfo {
  /** Canonical index 0..168 (matches handGroupIndex). */
  index: number;
  /** Canonical name e.g. "AA", "AKs", "72o". */
  name: string;
  kind: Kind;
  /** Number of distinct 2-card combos: pair=6, suited=4, offsuit=12. */
  comboCount: number;
  /** All concrete 2-card combos belonging to this category. */
  combos: [CardId, CardId][];
}

function buildCategories(): CategoryInfo[] {
  // Bucket every one of the 1326 hole-card combos by its category index.
  const byIndex = new Map<number, [CardId, CardId][]>();
  const nameByIndex = new Map<number, string>();
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      const idx = handGroupIndex(a, b);
      if (!byIndex.has(idx)) {
        byIndex.set(idx, []);
        nameByIndex.set(idx, handGroupName(a, b));
      }
      byIndex.get(idx)!.push([a, b]);
    }
  }

  const cats: CategoryInfo[] = [];
  for (let idx = 0; idx < NUM_CATEGORIES; idx++) {
    const combos = byIndex.get(idx)!;
    const count = combos.length;
    let kind: Kind;
    if (count === 6) kind = 'pair';
    else if (count === 4) kind = 'suited';
    else kind = 'offsuit'; // count === 12
    cats.push({
      index: idx,
      name: nameByIndex.get(idx)!,
      kind,
      comboCount: count,
      combos,
    });
  }
  return cats;
}

let _categories: CategoryInfo[] | null = null;

/** All 169 categories, indexed by canonical index. */
export function categories(): CategoryInfo[] {
  if (!_categories) _categories = buildCategories();
  return _categories;
}

let _nameToIndex: Map<string, number> | null = null;

/** Map a canonical hand name ("AKs") to its category index. */
export function nameToIndex(name: string): number {
  if (!_nameToIndex) {
    _nameToIndex = new Map();
    for (const c of categories()) _nameToIndex.set(c.name, c.index);
  }
  const i = _nameToIndex.get(name);
  if (i === undefined) throw new Error(`Unknown hand name: ${name}`);
  return i;
}

/** Combo-count weight for a category index (pair=6, suited=4, offsuit=12). */
export function comboWeight(index: number): number {
  return categories()[index].comboCount;
}
