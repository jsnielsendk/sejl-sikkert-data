import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { forecastWindow } from '../src/app/client';
import { parseCoverage } from '../src/app/coverage';
import { forecastFromCoverage } from '../src/app/convert';
import { gridFromTimedSamples, VISIBLE_AXIS_MAX } from '../src/app/vectorGrid';
import { DENMARK_BOUNDS } from '../src/config';
import { FIXTURE_PATH, readFixture } from './support';

const EARLIEST = Date.parse('2026-11-25T18:00:00Z');

describe('DMI conversion', () => {
  it('reads the saved DMI cube into a 10 by 10 field', () => {
    const raw = readFixture();
    const saved = readFileSync(FIXTURE_PATH, 'utf8');
    expect(saved.length).toBeLessThan(20_000);
    expect(saved).toContain('"type" : "Coverage"');
    const grid = parseCoverage(raw);
    expect(grid).not.toBeNull();
    expect(grid?.unit).toBe('kilometre');
    expect(grid?.parameters['wind-10m-u']?.[0]?.[0]?.[0]).toBe(-2.2240372);

    const forecast = forecastFromCoverage({
      grid: grid!,
      kind: 'wind',
      regionId: 'dk',
      model: 'harmonie_dini_sf',
      modelRunAt: '2026-11-25T15:00:00.000Z',
      fetchedAt: '2026-11-25T18:00:00.000Z',
      nowMs: EARLIEST,
      earliestMs: EARLIEST,
      latestMs: EARLIEST + 48 * 60 * 60 * 1000,
      bounds: DENMARK_BOUNDS,
    });
    expect(forecast?.geometry.kind).toBe('grid');
    if (forecast?.geometry.kind !== 'grid') {
      return;
    }
    expect(forecast.geometry.latitudes).toHaveLength(VISIBLE_AXIS_MAX);
    expect(forecast.geometry.longitudes).toHaveLength(VISIBLE_AXIS_MAX);
    expect(forecast.timeAxis).toEqual(['2026-11-25T18:00:00Z']);
    const speeds = forecast.geometry.samples.flatMap((step) =>
      step.flatMap((row) => row.flatMap((cell) => (cell.wind ? [cell.wind.speed] : []))),
    );
    expect(speeds.length).toBeGreaterThan(0);
    expect(Math.max(...speeds)).toBeGreaterThan(0);
  });

  it('keeps +0, +24 and +48 and the strongest vector in each 10 by 10 cell', () => {
    const start = new Date(EARLIEST);
    const window = forecastWindow(new Date('2026-11-25T18:20:00Z'));
    expect(window.start.toISOString()).toBe('2026-11-25T18:00:00.000Z');
    expect(window.end.getTime() - window.start.getTime()).toBe(48 * 60 * 60 * 1000);

    const times = [0, 1, 24, 25, 48].map((hour) =>
      new Date(EARLIEST + hour * 60 * 60 * 1000).toISOString().replace('.000Z', 'Z'),
    );
    const keptSpeeds = [1, 3, 2, 0.5];
    const values: number[] = [];
    const uValues: number[] = [];
    for (const hour of [0, 1, 24, 25, 48]) {
      const dropped = hour === 1 || hour === 25;
      for (const speed of keptSpeeds) {
        uValues.push(0);
        values.push(dropped ? 100 : speed);
      }
    }
    const grid = parseCoverage({
      type: 'Coverage',
      domain: {
        type: 'Domain',
        axes: {
          t: { values: times },
          x: { values: [10.1, 10.11] },
          y: { values: [55.1, 55.11] },
        },
      },
      ranges: {
        'wind-10m-u': { shape: [5, 2, 2], values: uValues },
        'wind-10m-v': { shape: [5, 2, 2], values },
      },
    });
    expect(grid?.unit).toBe('degree');
    const forecast = forecastFromCoverage({
      grid: grid!,
      kind: 'wind',
      regionId: 'dk',
      model: 'harmonie_dini_sf',
      modelRunAt: '2026-11-25T15:00:00.000Z',
      fetchedAt: start.toISOString(),
      nowMs: start.getTime(),
      earliestMs: start.getTime(),
      latestMs: start.getTime() + 48 * 60 * 60 * 1000,
      bounds: { west: 10, south: 55, east: 12, north: 57 },
    });
    expect(forecast?.timeAxis).toEqual([
      '2026-11-25T18:00:00Z',
      '2026-11-26T18:00:00Z',
      '2026-11-27T18:00:00Z',
    ]);
    if (forecast?.geometry.kind !== 'grid') {
      throw new Error('expected a grid');
    }
    expect(forecast.geometry.latitudes).toHaveLength(10);
    expect(forecast.geometry.longitudes).toHaveLength(10);
    const filled = forecast.geometry.samples.flatMap((step, time) =>
      step.flatMap((row, y) =>
        row.flatMap((cell, x) => (cell.wind ? [{ time, y, x, ...cell.wind }] : [])),
      ),
    );
    expect(filled).toHaveLength(3);
    expect(new Set(filled.map((cell) => `${cell.y}:${cell.x}`)).size).toBe(1);
    for (const cell of filled) {
      expect(cell.speed).toBeCloseTo(3, 6);
      expect(cell.directionDegrees).toBeCloseTo(180, 6);
      expect(cell.unit).toBe('m/s');
    }
  });

  it('keeps the stronger sample when gridFromTimedSamples sees the same point twice', () => {
    const grid = gridFromTimedSamples([
      {
        time: '2026-11-25T18:00:00Z',
        latitude: 55.1,
        longitude: 10.1,
        speed: 1,
        directionDegrees: 10,
      },
      {
        time: '2026-11-25T18:00:00Z',
        latitude: 55.1,
        longitude: 10.1,
        speed: 4,
        directionDegrees: 200,
      },
    ]);
    expect(grid.times).toEqual(['2026-11-25T18:00:00Z']);
    expect(grid.cells[0]?.[0]?.[0]?.speed).toBe(4);
    expect(grid.cells[0]?.[0]?.[0]?.directionDegrees).toBe(200);
  });
});
