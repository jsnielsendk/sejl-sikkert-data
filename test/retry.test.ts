import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_ATTEMPTS, REQUEST_PAUSE_MS, RETRY_DELAYS_MS, tilesFromConfig } from '../src/config';
import { createSerialClient, fetchJson, type FetchStats } from '../src/dmi/serial';
import { buildDataset } from '../src/pipeline';
import { coverageBody, jsonResponse } from './support';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function stats(): FetchStats {
  return { calls: 0, saw429: false };
}

describe('DMI retry', () => {
  it('retries a 429 with backoff and stops after three attempts', async () => {
    const sleeps: number[] = [];
    const statuses = [429, 200];
    const seen = stats();
    const result = await fetchJson({
      url: 'https://opendataapi.dmi.dk/v1/forecastedr/collections/harmonie_dini_sf/instances',
      stats: seen,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      http: async () => jsonResponse(statuses.shift() ?? 200, { instances: [] }),
    });
    expect(result.status).toBe(200);
    expect(seen.calls).toBe(2);
    expect(seen.saw429).toBe(true);
    expect(sleeps).toEqual([RETRY_DELAYS_MS[0]]);

    const exhausted = stats();
    const busy = await fetchJson({
      url: 'https://opendataapi.dmi.dk/example',
      stats: exhausted,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      http: async () => jsonResponse(429, { message: 'busy' }),
    });
    expect(busy.status).toBe(429);
    expect(exhausted.calls).toBe(MAX_ATTEMPTS);
    expect(sleeps.slice(-2)).toEqual([...RETRY_DELAYS_MS]);

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
    expect(waited).toEqual([Math.max(RETRY_DELAYS_MS[0], 30_000)]);

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
