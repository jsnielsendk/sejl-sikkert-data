import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { main } from '../src/cli';
import { MAX_ATTEMPTS, tilesFromConfig } from '../src/config';
import { jsonResponse } from './support';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('failed build', () => {
  it('exits non-zero and does not leave a manifest when a tile fails', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'sejl-fail-'));
    dirs.push(outDir);
    const calls: string[] = [];
    const code = await main(['node', 'cli', '--out', outDir], {
      now: new Date('2026-11-25T18:20:00.000Z'),
      tiles: tilesFromConfig().slice(0, 1),
      pauseMs: 0,
      sleep: async () => undefined,
      http: (url) => {
        calls.push(url);
        if (url.includes('/instances') && !url.includes('/cube')) {
          return Promise.resolve(jsonResponse(200, { instances: [{ id: '2026-11-25T150000Z' }] }));
        }
        return Promise.resolve(jsonResponse(500, { message: 'down' }));
      },
    });
    expect(code).not.toBe(0);
    expect(existsSync(path.join(outDir, 'manifest.json'))).toBe(false);
    expect(existsSync(`${path.resolve(outDir)}.partial`)).toBe(false);
    const cubes = calls.filter((url) => url.includes('/cube')).length;
    expect(cubes).toBeGreaterThanOrEqual(5);
    expect(cubes).toBeLessThanOrEqual(MAX_ATTEMPTS);
  });
});
