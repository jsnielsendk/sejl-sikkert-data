import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_ATTEMPTS,
  MAX_RETRY_AFTER_MS,
  MAX_RETRY_BUDGET_MS,
  pauseMsFromEnv,
  REQUEST_PAUSE_MS,
  RETRY_BASE_MS,
  tilesFromConfig,
} from '../src/config';
import { createSerialClient, fetchJson, retryDelayMs, type FetchStats } from '../src/dmi/serial';
import { buildDataset } from '../src/pipeline';
import { coverageBody, jsonResponse } from './support';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function stats(): FetchStats {
  return { calls: 0, saw429: false };
}

describe('request pause', () => {
  it('reads DMI_PAUSE_MS and keeps the default when the variable is unset', () => {
    expect(pauseMsFromEnv({})).toBe(REQUEST_PAUSE_MS);
    expect(pauseMsFromEnv({ DMI_PAUSE_MS: '  ' })).toBe(REQUEST_PAUSE_MS);
    expect(pauseMsFromEnv({ DMI_PAUSE_MS: '4000' })).toBe(4000);
    expect(() => pauseMsFromEnv({ DMI_PAUSE_MS: 'no' })).toThrow(/DMI_PAUSE_MS/);
    expect(MAX_ATTEMPTS).toBe(6);
    expect(MAX_RETRY_BUDGET_MS).toBe(360_000);
  });
});

describe('DMI retry', () => {
  it('follows Retry-After on 429 and caps a huge value', async () => {
    const waited: number[] = [];
    const hinted = stats();
    const afterHeader = await fetchJson({
      url: 'https://opendataapi.dmi.dk/retry-after',
      stats: hinted,
      sleep: async (ms) => {
        waited.push(ms);
      },
      http: async () => ({
        status: hinted.calls === 1 ? 429 : 200,
        body: new TextEncoder().encode('{}'),
        headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '30' : null) },
      }),
    });
    expect(afterHeader.status).toBe(200);
    expect(hinted.saw429).toBe(true);
    expect(waited).toEqual([30_000]);

    const now = Date.parse('2026-11-27T22:46:00.000Z');
    expect(
      retryDelayMs(
        0,
        { get: (name) => (name.toLowerCase() === 'retry-after' ? 'Fri, 27 Nov 2026 22:46:45 GMT' : null) },
        () => 1,
        now,
      ),
    ).toBe(45_000);

    const capped: number[] = [];
    const huge = stats();
    const afterHugeHeader = await fetchJson({
      url: 'https://opendataapi.dmi.dk/retry-after-huge',
      stats: huge,
      sleep: async (ms) => {
        capped.push(ms);
      },
      http: async () => ({
        status: huge.calls === 1 ? 429 : 200,
        body: new TextEncoder().encode('{}'),
        headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '600' : null) },
      }),
    });
    expect(afterHugeHeader.status).toBe(200);
    expect(capped).toEqual([MAX_RETRY_AFTER_MS]);
    expect(MAX_RETRY_AFTER_MS).toBe(120_000);
  });

  it('uses exponential jitter without Retry-After and stops at the budget', async () => {
    expect(retryDelayMs(0, undefined, () => 0)).toBe(RETRY_BASE_MS / 2);
    expect(retryDelayMs(0, undefined, () => 1)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(3, undefined, () => 1)).toBe(MAX_RETRY_AFTER_MS);

    const sleeps: number[] = [];
    const seen = stats();
    const busy = await fetchJson({
      url: 'https://opendataapi.dmi.dk/example',
      stats: seen,
      random: () => 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      http: async () => jsonResponse(429, { message: 'busy' }),
    });
    expect(busy.status).toBe(429);
    expect(seen.saw429).toBe(true);
    expect(sleeps).toEqual([20_000, 40_000, 80_000, 120_000]);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(MAX_RETRY_BUDGET_MS);
    expect(seen.calls).toBe(sleeps.length + 1);
    expect(seen.calls).toBeLessThan(MAX_ATTEMPTS);

    const server = stats();
    const recovered = await fetchJson({
      url: 'https://opendataapi.dmi.dk/example-5xx',
      stats: server,
      sleep: async () => undefined,
      http: async () => jsonResponse(server.calls === 1 ? 503 : 200, { ok: true }),
    });
    expect(recovered.status).toBe(200);
    expect(server.calls).toBe(2);

    const missing = stats();
    await fetchJson({
      url: 'https://opendataapi.dmi.dk/missing',
      stats: missing,
      sleep: async () => undefined,
      http: async () => jsonResponse(404, { message: 'no data' }),
    });
    expect(missing.calls).toBe(1);
    expect(missing.saw429).toBe(false);
  });

  it('pauses between serial calls and records a 429 during a build', async () => {
    const sleeps: number[] = [];
    const seen = stats();
    const get = createSerialClient({
      stats: seen,
      pauseMs: REQUEST_PAUSE_MS,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      http: async () => jsonResponse(200, { ok: true }),
    });
    await get('https://opendataapi.dmi.dk/one');
    await get('https://opendataapi.dmi.dk/two');
    expect(seen.calls).toBe(2);
    expect(sleeps).toEqual([REQUEST_PAUSE_MS]);

    const outDir = await mkdtemp(path.join(tmpdir(), 'sejl-retry-'));
    dirs.push(outDir);
    let cubes = 0;
    const report = await buildDataset({
      outDir,
      now: new Date('2026-11-25T18:20:00.000Z'),
      tiles: tilesFromConfig().slice(0, 1),
      pauseMs: 0,
      sleep: async () => undefined,
      http: (url) => {
        if (url.includes('/cube')) {
          cubes += 1;
          if (cubes === 1) {
            return Promise.resolve(jsonResponse(429, { message: 'busy' }));
          }
        }
        if (url.includes('/instances') && !url.includes('/cube')) {
          return Promise.resolve(jsonResponse(200, { instances: [{ id: '2026-11-25T150000Z' }] }));
        }
        return Promise.resolve(jsonResponse(200, coverageBody(url)));
      },
    });
    expect(report.saw429).toBe(true);
    expect(cubes).toBeGreaterThan(1);
  });
});
