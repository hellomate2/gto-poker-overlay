import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, BotSettings } from '../src/types/poker';

describe('DEFAULT_SETTINGS', () => {
  it('has sane, well-typed default values', () => {
    expect(typeof DEFAULT_SETTINGS.autoPlay).toBe('boolean');
    expect(typeof DEFAULT_SETTINGS.advisoryMode).toBe('boolean');
    expect(typeof DEFAULT_SETTINGS.showHud).toBe('boolean');
    expect(typeof DEFAULT_SETTINGS.confirmAllIn).toBe('boolean');
  });

  it('uses a valid action delay window (min <= max, both positive)', () => {
    expect(DEFAULT_SETTINGS.actionDelayMin).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.actionDelayMax).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.actionDelayMin);
  });

  it('keeps exploitWeight within [0, 1]', () => {
    expect(DEFAULT_SETTINGS.exploitWeight).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_SETTINGS.exploitWeight).toBeLessThanOrEqual(1);
  });

  it('configures positive CFR compute budgets', () => {
    expect(DEFAULT_SETTINGS.cfrIterations).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.cfrTimeLimit).toBeGreaterThan(0);
  });

  it('defaults to advisory mode (auto-play off) so it never acts on its own', () => {
    expect(DEFAULT_SETTINGS.autoPlay).toBe(false);
    expect(DEFAULT_SETTINGS.advisoryMode).toBe(true);
  });

  it('can be spread into an override without mutation', () => {
    const custom: BotSettings = { ...DEFAULT_SETTINGS, autoPlay: true };
    expect(custom.autoPlay).toBe(true);
    expect(DEFAULT_SETTINGS.autoPlay).toBe(false); // original untouched
  });
});
