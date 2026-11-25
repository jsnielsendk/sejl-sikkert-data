import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DATA_ATTRIBUTION,
  DATA_LICENSE,
  DATA_LICENSE_URL,
  FORMAT_VERSION,
  tilesFromConfig,
} from '../src/config';
import { buildDataset } from '../src/pipeline';
import { coverageBody, jsonResponse, scriptedHttp } from './support';

const NOW = new Date('2026-11-25T18:20:00.000Z');
const dirs: string[] = [];

async function tempOut(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sejl-data-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('manifest', () => {
  it('lists every tile with bbox, bytes, sha256, format version and DMI credit', async () => {
    const outDir = await tempOut();
    const transport = scriptedHttp();
    const report = await buildDataset({
      outDir,
      now: NOW,
      http: transport.http,
      sleep: async () => undefined,
      pauseMs: 0,
    });
    expect(report.saw429).toBe(false);
    expect(transport.calls.some((url) => url.startsWith('https://opendataapi.dmi.dk/'))).toBe(true);
    expect(transport.calls.every((url) => !url.includes('api-key') && !url.includes('apikey'))).toBe(
      true,
    );

    const manifestRaw = await readFile(path.join(outDir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw) as {
      generatedAt: string;
      formatVersion: string;
      attribution: string;
      license: string;
      licenseUrl: string;
      modelRuns: { kind: string; model: string; modelRunAt: string }[];
      tiles: {
        id: string;
        kind: string;
        bbox: { west: number; south: number; east: number; north: number };
        file: string;
        bytes: number;
        sha256: string;
        model: string;
        modelRunAt: string;
      }[];
    };
    expect(manifest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    expect(Number.isNaN(Date.parse(manifest.generatedAt))).toBe(false);
    expect(manifest.formatVersion).toBe(FORMAT_VERSION);
    expect(manifest.attribution).toBe(DATA_ATTRIBUTION);
    expect(manifest.license).toBe(DATA_LICENSE);
    expect(manifest.licenseUrl).toBe(DATA_LICENSE_URL);
    expect(manifestRaw).toContain(DATA_ATTRIBUTION);
    const index = await readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(index).toContain(DATA_ATTRIBUTION);
    expect(index).toContain(DATA_LICENSE_URL);
    expect(index).toContain('manifest.json');
    const nojekyll = await stat(path.join(outDir, '.nojekyll'));
    expect(nojekyll.isFile()).toBe(true);
    expect(manifest.modelRuns.map((run) => run.model)).toContain('harmonie_dini_sf');
    expect(manifest.modelRuns.some((run) => run.model.startsWith('dkss_'))).toBe(true);

    const expected = tilesFromConfig();
    expect(manifest.tiles).toHaveLength(expected.length * 2);
    for (const tile of expected) {
      for (const kind of ['wind', 'current'] as const) {
        const entry = manifest.tiles.find((item) => item.id === tile.id && item.kind === kind);
        expect(entry).toBeTruthy();
        expect(entry?.bbox).toEqual(tile.bbox);
        expect(entry?.file).toBe(`${kind}/${tile.id}.json`);
        const file = await readFile(path.join(outDir, entry!.file));
        expect(file.byteLength).toBe(entry?.bytes);
        expect(createHash('sha256').update(file).digest('hex')).toBe(entry?.sha256);
        const body = JSON.parse(file.toString('utf8')) as {
          attribution: string;
          license: string;
          licenseUrl: string;
          geometry: { kind: string; latitudes: number[]; longitudes: number[] };
          timeAxis: string[];
        };
        expect(body.attribution).toBe(DATA_ATTRIBUTION);
        expect(body.license).toBe(DATA_LICENSE);
        expect(body.licenseUrl).toBe(DATA_LICENSE_URL);
        expect(file.toString('utf8')).toContain(DATA_ATTRIBUTION);
        expect(body.geometry.kind).toBe('grid');
        expect(body.geometry.latitudes).toHaveLength(10);
        expect(body.geometry.longitudes).toHaveLength(10);
        expect(body.timeAxis[0]).toBe('2026-11-25T18:00:00Z');
        expect(body.timeAxis).toContain('2026-11-26T18:00:00Z');
        expect(body.timeAxis.at(-1)).toBe('2026-11-27T18:00:00Z');
      }
    }
  });

  it('keeps an empty current grid when the cube has no sea samples', async () => {
    const outDir = await tempOut();
    const tile = tilesFromConfig().find((item) => item.id === 'r2c4');
    expect(tile).toBeTruthy();
    await buildDataset({
      outDir,
      now: NOW,
      tiles: tile ? [tile] : [],
      pauseMs: 0,
      sleep: async () => undefined,
      http: (url) => {
        if (url.includes('/instances') && !url.includes('/cube')) {
          return Promise.resolve(jsonResponse(200, { instances: [{ id: '2026-11-25T150000Z' }] }));
        }
        const body = coverageBody(url) as {
          ranges: Record<string, { values: Array<number | null> }>;
        };
        if (url.includes('current-')) {
          for (const range of Object.values(body.ranges)) {
            range.values = range.values.map(() => null);
          }
        }
        return Promise.resolve(jsonResponse(200, body));
      },
    });
    const current = JSON.parse(await readFile(path.join(outDir, 'current', 'r2c4.json'), 'utf8')) as {
      attribution: string;
      licenseUrl: string;
      timeAxis: string[];
      geometry: { latitudes: number[]; longitudes: number[]; samples: { current?: unknown }[][][] };
    };
    expect(current.attribution).toBe(DATA_ATTRIBUTION);
    expect(current.licenseUrl).toBe(DATA_LICENSE_URL);
    expect(current.timeAxis[0]).toBe('2026-11-25T18:00:00Z');
    expect(current.timeAxis).toContain('2026-11-26T18:00:00Z');
    expect(current.timeAxis.at(-1)).toBe('2026-11-27T18:00:00Z');
    expect(current.geometry.latitudes).toHaveLength(10);
    expect(current.geometry.longitudes).toHaveLength(10);
    const vectors = current.geometry.samples.flat(2).filter((cell) => cell.current);
    expect(vectors).toHaveLength(0);
    expect(existsSync(path.join(outDir, 'manifest.json'))).toBe(true);
  });
});
