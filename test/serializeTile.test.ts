import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseCoverage } from '../src/app/coverage';
import { forecastFromCoverage } from '../src/app/convert';
import type { NeutralForecast } from '../src/app/types';
import { DATA_ATTRIBUTION } from '../src/config';
import { buildDataset } from '../src/pipeline';
import { serializeTile } from '../src/serializeTile';
import { scriptedHttp } from './support';

const NOW = new Date('2026-11-25T18:20:00.000Z');
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tile(samples: NeutralForecast['geometry']): NeutralForecast {
  return {
    regionId: 'dk',
    providerId: 'dmi-edr',
    model: 'harmonie_dini_sf',
    modelRunAt: '2026-11-26T15:00:00.000Z',
    fetchedAt: '2026-11-26T18:00:00.000Z',
    expiresAt: '2026-11-26T21:00:00Z',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: DATA_ATTRIBUTION,
    timeAxis: ['2026-11-26T18:00:00Z'],
    geometry: samples,
  };
}

function decimalPlaces(value: number): number {
  const text = JSON.stringify(value);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

function directionError(actual: number, expected: number): number {
  const delta = Math.abs(actual - expected) % 360;
  return Math.min(delta, 360 - delta);
}

describe('tile serialization', () => {
  it('rounds written numbers without moving them by more than half a step', () => {
    const original = tile({
      kind: 'grid',
      latitudes: [55.123456789, 56.5],
      longitudes: [10.987654321],
      samples: [
        [
          [{ wind: { directionDegrees: 10.4, speed: 1.6, unit: 'm/s' } }],
          [{ current: { directionDegrees: 200.6, speed: 0.226, unit: 'm/s' } }],
        ],
      ],
    });
    const json = serializeTile(original);
    const written = JSON.parse(json) as NeutralForecast;
    expect(written.geometry.kind).toBe('grid');
    if (written.geometry.kind !== 'grid' || original.geometry.kind !== 'grid') {
      return;
    }
    for (const latitude of written.geometry.latitudes) {
      expect(decimalPlaces(latitude)).toBeLessThanOrEqual(4);
    }
    for (const longitude of written.geometry.longitudes) {
      expect(decimalPlaces(longitude)).toBeLessThanOrEqual(4);
    }
    written.geometry.samples.forEach((step, time) => {
      step.forEach((row, y) => {
        row.forEach((cell, x) => {
          for (const kind of ['wind', 'current'] as const) {
            const vector = cell[kind];
            const source = original.geometry.kind === 'grid' ? original.geometry.samples[time]?.[y]?.[x]?.[kind] : undefined;
            if (!vector || !source) {
              continue;
            }
            expect(decimalPlaces(vector.directionDegrees)).toBe(0);
            expect(directionError(vector.directionDegrees, source.directionDegrees)).toBeLessThanOrEqual(0.5);
            if (kind === 'wind') {
              expect(decimalPlaces(vector.speed)).toBe(0);
              expect(Math.abs(vector.speed - source.speed)).toBeLessThanOrEqual(0.5);
            } else {
              expect(decimalPlaces(vector.speed)).toBeLessThanOrEqual(2);
              expect(Math.abs(vector.speed - source.speed)).toBeLessThanOrEqual(0.005);
            }
          }
        });
      });
    });
    expect(written.geometry.latitudes[0]).toBe(55.1235);
    expect(written.geometry.longitudes[0]).toBe(10.9877);
    expect(written.geometry.samples[0]?.[0]?.[0]?.wind?.speed).toBe(2);
    expect(written.geometry.samples[0]?.[0]?.[0]?.wind?.directionDegrees).toBe(10);
    expect(written.geometry.samples[0]?.[1]?.[0]?.current?.speed).toBe(0.23);
    expect(written.geometry.samples[0]?.[1]?.[0]?.current?.directionDegrees).toBe(201);
  });

  it('writes direction 359.6 as 0 for wind and current and leaves an empty cell empty', () => {
    const json = serializeTile(
      tile({
        kind: 'grid',
        latitudes: [55],
        longitudes: [10, 11],
        samples: [
          [
            [
              { wind: { directionDegrees: 359.6, speed: 3.4, unit: 'm/s' } },
              { current: { directionDegrees: 359.6, speed: 0.226, unit: 'm/s' } },
            ],
            [{}, {}],
          ],
        ],
      }),
    );
    expect(json).not.toContain('360');
    const written = JSON.parse(json) as NeutralForecast;
    if (written.geometry.kind !== 'grid') {
      throw new Error('expected a grid');
    }
    expect(written.geometry.samples[0]?.[0]?.[0]?.wind?.directionDegrees).toBe(0);
    expect(written.geometry.samples[0]?.[0]?.[0]?.wind?.speed).toBe(3);
    expect(written.geometry.samples[0]?.[0]?.[1]?.current?.directionDegrees).toBe(0);
    expect(written.geometry.samples[0]?.[1]?.[0]).toEqual({});
    expect(JSON.stringify(written.geometry.samples[0]?.[1]?.[0])).toBe('{}');
  });

  it('keeps full precision until the file is written, and the manifest hashes those bytes', async () => {
    const grid = parseCoverage({
      type: 'Coverage',
      domain: {
        type: 'Domain',
        axes: {
          t: { values: ['2026-11-26T18:00:00Z'] },
          y: { values: [55.1, 55.11] },
          x: { values: [10.1, 10.11] },
        },
      },
      ranges: {
        'wind-speed-10m': { shape: [1, 2, 2], values: [1.994, 1.991, 0.2, 0.1] },
        'wind-dir-10m': { shape: [1, 2, 2], values: [10, 20, 30, 40] },
      },
    });
    const forecast = forecastFromCoverage({
      grid: grid!,
      kind: 'wind',
      regionId: 'dk',
      model: 'harmonie_dini_sf',
      modelRunAt: NOW.toISOString(),
      fetchedAt: NOW.toISOString(),
      nowMs: NOW.getTime(),
      earliestMs: Date.parse('2026-11-26T18:00:00Z'),
      latestMs: Date.parse('2026-11-28T18:00:00Z'),
      bounds: { west: 10, south: 55, east: 12, north: 57 },
    });
    if (forecast?.geometry.kind !== 'grid') {
      throw new Error('expected a grid');
    }
    const speeds = forecast.geometry.samples.flat(2).flatMap((cell) => (cell.wind ? [cell.wind.speed] : []));
    expect(Math.max(...speeds)).toBeCloseTo(1.994, 6);
    const written = JSON.parse(serializeTile(forecast)) as NeutralForecast;
    if (written.geometry.kind !== 'grid') {
      throw new Error('expected a written grid');
    }
    const writtenSpeeds = written.geometry.samples.flat(2).flatMap((cell) => (cell.wind ? [cell.wind.speed] : []));
    expect(Math.max(...writtenSpeeds)).toBe(2);

    const outDir = await mkdtemp(path.join(tmpdir(), 'sejl-round-'));
    dirs.push(outDir);
    await buildDataset({
      outDir,
      now: NOW,
      tiles: [{ id: 'r0c0', bbox: { west: 10, south: 55, east: 12, north: 57 } }],
      http: scriptedHttp().http,
      sleep: async () => undefined,
      pauseMs: 0,
    });
    const manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8')) as {
      formatVersion: string;
      tiles: { file: string; bytes: number; sha256: string }[];
    };
    expect(manifest.formatVersion).toBe('1');
    for (const entry of manifest.tiles) {
      const file = await readFile(path.join(outDir, entry.file));
      expect(file.byteLength).toBe(entry.bytes);
      expect(createHash('sha256').update(file).digest('hex')).toBe(entry.sha256);
    }
  });
});
