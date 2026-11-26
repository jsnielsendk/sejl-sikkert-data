import { describe, expect, it } from 'vitest';

import { decideManifestFreshness, FRESH_MS, STALE_WARN_MS } from '../scripts/manifestFreshness';

const NOW = Date.parse('2026-11-26T12:00:00Z');

function at(ageMs: number): string {
  return new Date(NOW - ageMs).toISOString();
}

describe('manifest freshness', () => {
  it('skips DMI when the published manifest is younger than two hours', () => {
    const decision = decideManifestFreshness({ generatedAt: at(30 * 60 * 1000), nowMs: NOW });
    expect(decision.skip).toBe(true);
    expect(decision.warn).toBe(false);
    expect(decision.ageMs).toBe(30 * 60 * 1000);
    expect(decideManifestFreshness({ generatedAt: at(0), nowMs: NOW }).skip).toBe(true);
  });

  it('builds again once the manifest is two hours old, and warns after six', () => {
    const due = decideManifestFreshness({ generatedAt: at(FRESH_MS), nowMs: NOW });
    expect(due.skip).toBe(false);
    expect(due.warn).toBe(false);

    const between = decideManifestFreshness({ generatedAt: at(3 * 60 * 60 * 1000), nowMs: NOW });
    expect(between.skip).toBe(false);
    expect(between.warn).toBe(false);

    const stale = decideManifestFreshness({ generatedAt: at(STALE_WARN_MS + 60_000), nowMs: NOW });
    expect(stale.skip).toBe(false);
    expect(stale.warn).toBe(true);

    const exact = decideManifestFreshness({ generatedAt: at(STALE_WARN_MS), nowMs: NOW });
    expect(exact.warn).toBe(false);
  });

  it('builds and warns when generatedAt is in the future', () => {
    const decision = decideManifestFreshness({
      generatedAt: new Date(NOW + 60_000).toISOString(),
      nowMs: NOW,
    });
    expect(decision.ageMs).toBe(-60_000);
    expect(decision.skip).toBe(false);
    expect(decision.warn).toBe(true);
  });

  it('builds when the manifest cannot be read', () => {
    expect(decideManifestFreshness({ generatedAt: null, nowMs: NOW }).skip).toBe(false);
    expect(decideManifestFreshness({ generatedAt: 'yesterday', nowMs: NOW }).skip).toBe(false);
  });
});
