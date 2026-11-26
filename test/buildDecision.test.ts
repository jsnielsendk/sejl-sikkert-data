import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  decideBuild,
  instancesUrl,
  latestInstanceRun,
  reportBuildDecision,
  type DmiRun,
} from '../scripts/buildDecision.ts';

const NOW = Date.parse('2026-11-26T18:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function runs(harmonie: string, current: string) {
  return [
    { model: 'harmonie_dini_sf', modelRunAt: harmonie },
    { model: 'dkss_nsbs', modelRunAt: current },
  ];
}

function dmi(harmonie: string | null, current: string | null): DmiRun[] {
  return [
    { model: 'harmonie_dini_sf', modelRunAt: harmonie, bytes: 320372 },
    { model: 'dkss_nsbs', modelRunAt: current, bytes: 190781 },
  ];
}

describe('decideBuild', () => {
  it('builds when one DMI model run is newer', () => {
    const decision = decideBuild({
      nowMs: NOW,
      generatedAt: new Date(NOW - HOUR).toISOString(),
      manifestModelRuns: runs('2026-11-26T12:00:00.000Z', '2026-11-26T12:00:00.000Z'),
      dmi: dmi('2026-11-26T15:00:00.000Z', '2026-11-26T12:00:00.000Z'),
    });
    expect(decision.build).toBe(true);
    expect(decision.reason).toBe('BUILD newer model run');
    expect(decision.lines.join('\n')).toContain('harmonie_dini_sf dmi=2026-11-26T15:00:00.000Z');
  });

  it('skips when both runs match and the manifest is under 12 hours', () => {
    const decision = decideBuild({
      nowMs: NOW,
      generatedAt: new Date(NOW - 3 * HOUR).toISOString(),
      manifestModelRuns: runs('2026-11-26T12:00:00.000Z', '2026-11-26T12:00:00.000Z'),
      dmi: dmi('2026-11-26T12:00:00.000Z', '2026-11-26T12:00:00.000Z'),
    });
    expect(decision.build).toBe(false);
    expect(decision.reason).toContain('SKIP');
  });

  it('builds the same run when the manifest is at least 12 hours old', () => {
    const decision = decideBuild({
      nowMs: NOW,
      generatedAt: new Date(NOW - 12 * HOUR).toISOString(),
      manifestModelRuns: runs('2026-11-26T06:00:00.000Z', '2026-11-26T06:00:00.000Z'),
      dmi: dmi('2026-11-26T06:00:00.000Z', '2026-11-26T06:00:00.000Z'),
    });
    expect(decision.build).toBe(true);
    expect(decision.reason).toContain('safety');
    expect(decision.warnStale).toBe(true);
    expect(decision.lines.join('\n')).toContain('MANIFEST_STALE');
  });

  it('builds when one model is newer even if the other does not answer', () => {
    const decision = decideBuild({
      nowMs: NOW,
      generatedAt: new Date(NOW - HOUR).toISOString(),
      manifestModelRuns: runs('2026-11-26T12:00:00.000Z', '2026-11-26T12:00:00.000Z'),
      dmi: dmi(null, '2026-11-26T15:00:00.000Z'),
    });
    expect(decision.build).toBe(true);
    expect(decision.warnDmi).toBe(true);
    expect(decision.reason).toBe('BUILD newer model run');
    expect(decision.lines.join('\n')).toContain(
      '::warning::DMI model run unavailable for one model; building on the newer run',
    );
  });

  it('falls back to a 2 hour age check when DMI does not show a newer run', () => {
    const fresh = decideBuild({
      nowMs: NOW,
      generatedAt: new Date(NOW - HOUR).toISOString(),
      manifestModelRuns: runs('2026-11-26T15:00:00.000Z', '2026-11-26T12:00:00.000Z'),
      dmi: dmi(null, '2026-11-26T12:00:00.000Z'),
    });
    expect(fresh.build).toBe(false);
    expect(fresh.warnDmi).toBe(true);
    const due = decideBuild({
      nowMs: NOW,
      generatedAt: new Date(NOW - 2 * HOUR).toISOString(),
      manifestModelRuns: runs('2026-11-26T12:00:00.000Z', '2026-11-26T12:00:00.000Z'),
      dmi: null,
    });
    expect(due.build).toBe(true);
    expect(due.warnDmi).toBe(true);
  });

  it('builds when the manifest cannot be read', () => {
    const decision = decideBuild({
      nowMs: NOW,
      generatedAt: null,
      manifestModelRuns: [],
      dmi: dmi('2026-11-26T15:00:00.000Z', '2026-11-26T12:00:00.000Z'),
    });
    expect(decision.build).toBe(true);
    expect(decision.reason).toContain('unreadable');
  });

  it('does not skip a future manifest timestamp', () => {
    const decision = decideBuild({
      nowMs: NOW,
      generatedAt: new Date(NOW + HOUR).toISOString(),
      manifestModelRuns: runs('2026-11-26T15:00:00.000Z', '2026-11-26T12:00:00.000Z'),
      dmi: dmi('2026-11-26T15:00:00.000Z', '2026-11-26T12:00:00.000Z'),
    });
    expect(decision.build).toBe(true);
    expect(decision.warnFuture).toBe(true);
    expect(decision.lines.join('\n')).toContain('MANIFEST_FUTURE');
  });

  it('builds when force is set, without treating the run as stale', () => {
    const decision = decideBuild({
      nowMs: NOW,
      generatedAt: new Date(NOW - HOUR).toISOString(),
      manifestModelRuns: runs('2026-11-26T15:00:00.000Z', '2026-11-26T12:00:00.000Z'),
      dmi: dmi('2026-11-26T15:00:00.000Z', '2026-11-26T12:00:00.000Z'),
      force: true,
    });
    expect(decision.build).toBe(true);
    expect(decision.reason).toBe('BUILD force');
  });
});

describe('latestInstanceRun', () => {
  it('keeps the newest run inside the last 24 hours and drops future or old ids', () => {
    expect(instancesUrl('harmonie_dini_sf')).toBe(
      'https://opendataapi.dmi.dk/v1/forecastedr/collections/harmonie_dini_sf/instances',
    );
    expect(
      latestInstanceRun(
        {
          instances: [
            { id: '2026-11-26T210000Z' },
            { id: '2026-11-25T120000Z' },
            { id: '2026-11-26T120000Z' },
            { id: '2026-11-26T150000Z' },
          ],
        },
        NOW,
      ),
    ).toBe('2026-11-26T15:00:00.000Z');
    expect(
      latestInstanceRun({ instances: [{ id: '2026-11-27T000000Z' }, { id: '2026-11-25T000000Z' }] }, NOW),
    ).toBeNull();
  });
});

describe('reportBuildDecision', () => {
  it('writes skip=false when the fetched model run is newer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'build-decision-'));
    const output = path.join(dir, 'github-output.txt');
    const decision = await reportBuildDecision({
      nowMs: NOW,
      outputPath: output,
      log: () => undefined,
      manifestUrl: 'https://example.test/manifest.json',
      fetchImpl: async (url) => {
        const href = String(url);
        if (href.includes('manifest')) {
          return new Response(
            JSON.stringify({
              generatedAt: new Date(NOW - HOUR).toISOString(),
              modelRuns: runs('2026-11-26T12:00:00.000Z', '2026-11-26T12:00:00.000Z'),
            }),
            { status: 200 },
          );
        }
        const id = href.includes('harmonie') ? '2026-11-26T150000Z' : '2026-11-26T120000Z';
        return new Response(JSON.stringify({ instances: [{ id }] }), { status: 200 });
      },
    });
    expect(decision.build).toBe(true);
    expect(readFileSync(output, 'utf8')).toBe('skip=false\n');
  });
});
