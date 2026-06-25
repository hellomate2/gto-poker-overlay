import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, BotSettings } from '../src/types/poker';

// DEFAULT_SETTINGS is the behavioral contract for the extension (auto-play vs
// advisory, action pacing, exploit blend, CFR budgets). These tests pin the
// CONCRETE default values, not just their types — a TS interface already
// guarantees the types, so a `typeof === 'boolean'` check verifies nothing the
// compiler doesn't. A silent default flip (e.g. autoPlay off, exploitWeight to
// pure GTO) is a real regression and must fail here.

describe('DEFAULT_SETTINGS', () => {
  it('pins every default value exactly', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      autoPlay: true,
      advisoryMode: false,
      actionDelayMin: 1500,
      actionDelayMax: 2500,
      exploitWeight: 0.5,
      showHud: true,
      showEquity: true,
      confirmAllIn: false,
      cfrIterations: 10000,
      cfrTimeLimit: 1500,
    });
  });

  it('exposes exactly the documented BotSettings keys (no missing/extra defaults)', () => {
    const expected = [
      'autoPlay', 'advisoryMode', 'actionDelayMin', 'actionDelayMax',
      'exploitWeight', 'showHud', 'showEquity', 'confirmAllIn',
      'cfrIterations', 'cfrTimeLimit',
    ].sort();
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(expected);
  });

  it('auto-play and advisory mode are mutually consistent (not both on)', () => {
    // advisoryMode = "recommend, do not click"; autoPlay = "click". They must not
    // both be true, or the bot would both act and claim to be advisory-only.
    expect(DEFAULT_SETTINGS.autoPlay && DEFAULT_SETTINGS.advisoryMode).toBe(false);
  });

  it('uses a valid action delay window (min <= max, human-paced ~1.5-2.5s)', () => {
    expect(DEFAULT_SETTINGS.actionDelayMin).toBe(1500);
    expect(DEFAULT_SETTINGS.actionDelayMax).toBe(2500);
    expect(DEFAULT_SETTINGS.actionDelayMin).toBeLessThanOrEqual(DEFAULT_SETTINGS.actionDelayMax);
  });

  it('exploitWeight is the half-GTO/half-exploit default within [0,1]', () => {
    expect(DEFAULT_SETTINGS.exploitWeight).toBe(0.5);
    expect(DEFAULT_SETTINGS.exploitWeight).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_SETTINGS.exploitWeight).toBeLessThanOrEqual(1);
  });

  it('configures concrete, positive CFR compute budgets', () => {
    expect(DEFAULT_SETTINGS.cfrIterations).toBe(10000);
    expect(DEFAULT_SETTINGS.cfrTimeLimit).toBe(1500);
    expect(DEFAULT_SETTINGS.cfrIterations).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.cfrTimeLimit).toBeGreaterThan(0);
  });

  it('can be spread into an override without mutating the shared default', () => {
    const custom: BotSettings = { ...DEFAULT_SETTINGS, autoPlay: false };
    expect(custom.autoPlay).toBe(false);
    expect(DEFAULT_SETTINGS.autoPlay).toBe(true); // original untouched
  });
});
