/**
 * Copied from jsnielsendk/sejl-sikkert-app@aa67b261981f151cc7869945ec0bcfb0f8917719
 * Source: src/features/weather/dmi/convert.ts
 * forecastFromCoverage is the path the app uses for a DMI cube: hours on the
 * 3-hour lattice from +0 through +48, then strongestBoxGrid at 10 by 10.
 * The published files replace attribution with the sentence required in this repo.
 */

import type { ForecastSample, NeutralForecast } from './types';
import { assertNeutralForecast } from './validate';
import { FORECAST_STEP_MS, strongestBoxGrid, type TimeVectorGrid } from './vectorGrid';

import type { CoverageGrid } from './coverage';
import { lambertInverse, normalizeDegrees, rotateGridVectorToTrue } from './lambert';

export const DMI_PROVIDER_ID = 'dmi-edr';
export const DMI_ATTRIBUTION = 'Baseret på data fra DMI og efterfølgende bearbejdet';
export const DMI_LICENSE = 'CC BY 4.0';
export const DMI_LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/';

type LonLatBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export function forecastFromCoverage(input: {
  grid: CoverageGrid;
  kind: 'wind' | 'current';
  regionId: string;
  model: string;
  modelRunAt: string;
  fetchedAt: string;
  nowMs: number;
  earliestMs: number;
  latestMs: number;
  bounds: LonLatBounds;
}): NeutralForecast | null {
  const inWindow = input.grid.times.flatMap((iso, index) => {
    const time = Date.parse(iso);
    if (Number.isNaN(time)) {
      return [];
    }
    if (time < input.earliestMs - 60_000 || time > input.latestMs + 60_000) {
      return [];
    }
    const offset = time - input.earliestMs;
    const nearest = Math.round(offset / FORECAST_STEP_MS);
    if (nearest < 0 || nearest > 16 || Math.abs(offset - nearest * FORECAST_STEP_MS) > 90_000) {
      return [];
    }
    return [{ index, time, iso }];
  });
  if (inWindow.length === 0) {
    return null;
  }
  const ordered = [...inWindow].sort((left, right) => left.time - right.time);
  const axes = axesLatLon(input.grid);
  const reader = sampleReader(input.grid, input.kind, axes.longitudeAt);
  return forecastFromTimeGrid({
    regionId: input.regionId,
    model: input.model,
    modelRunAt: input.modelRunAt,
    fetchedAt: input.fetchedAt,
    kind: input.kind,
    grid: strongestBoxGrid({
      times: ordered.map((step) => step.iso),
      yCount: axes.yCount,
      xCount: axes.xCount,
      latitudeAt: axes.latitudeAt,
      longitudeAt: axes.longitudeAt,
      speedAt: (time, y, x) => reader.speedAt(ordered[time]?.index ?? 0, y, x),
      directionAt: (time, y, x) => reader.directionAt(ordered[time]?.index ?? 0, y, x),
      bounds: input.bounds,
    }),
  });
}

function axesLatLon(grid: CoverageGrid): {
  yCount: number;
  xCount: number;
  latitudeAt: (y: number, x: number) => number;
  longitudeAt: (y: number, x: number) => number;
} {
  const yCount = grid.ys.length;
  const xCount = grid.xs.length;
  if (grid.unit === 'degree') {
    return {
      yCount,
      xCount,
      latitudeAt: (y) => grid.ys[y] ?? 0,
      longitudeAt: (_y, x) => grid.xs[x] ?? 0,
    };
  }
  const scale = grid.unit === 'kilometre' ? 1000 : 1;
  const latitudes = new Float64Array(yCount * xCount);
  const longitudes = new Float64Array(yCount * xCount);
  for (let y = 0; y < yCount; y += 1) {
    for (let x = 0; x < xCount; x += 1) {
      const projected = lambertInverse((grid.xs[x] ?? 0) * scale, (grid.ys[y] ?? 0) * scale);
      const index = y * xCount + x;
      latitudes[index] = projected.latitude;
      longitudes[index] = projected.longitude;
    }
  }
  return {
    yCount,
    xCount,
    latitudeAt: (y, x) => latitudes[y * xCount + x] ?? 0,
    longitudeAt: (y, x) => longitudes[y * xCount + x] ?? 0,
  };
}

function sampleReader(
  grid: CoverageGrid,
  kind: 'wind' | 'current',
  longitudeAt: (y: number, x: number) => number,
): {
  speedAt: (time: number, y: number, x: number) => number;
  directionAt: (time: number, y: number, x: number) => number;
} {
  const parameters = grid.parameters;
  const speedGrid = parameters['wind-speed-10m'] ?? parameters['wind-speed'] ?? null;
  const dirGrid = parameters['wind-dir-10m'] ?? parameters['wind-dir'] ?? null;
  const uName = kind === 'wind' ? 'wind-10m-u' : 'current-u';
  const vName = kind === 'wind' ? 'wind-10m-v' : 'current-v';
  const uGrid = parameters[uName] ?? (kind === 'wind' ? parameters['wind-u'] : null) ?? null;
  const vGrid = parameters[vName] ?? (kind === 'wind' ? parameters['wind-v'] : null) ?? null;
  const projected = grid.unit !== 'degree';
  const scratch = { u: 0, v: 0 };
  const components = (time: number, y: number, x: number): boolean => {
    const u = uGrid?.[time]?.[y]?.[x];
    const v = vGrid?.[time]?.[y]?.[x];
    if (typeof u !== 'number' || typeof v !== 'number') {
      return false;
    }
    if (!projected || kind !== 'wind') {
      scratch.u = u;
      scratch.v = v;
      return true;
    }
    rotateGridVectorToTrue(u, v, longitudeAt(y, x), scratch);
    return true;
  };
  return {
    speedAt: (time, y, x) => {
      const speed = speedGrid?.[time]?.[y]?.[x];
      const direction = dirGrid?.[time]?.[y]?.[x];
      if (typeof speed === 'number' && typeof direction === 'number') {
        return speed;
      }
      if (!components(time, y, x)) {
        return Number.NaN;
      }
      return Math.hypot(scratch.u, scratch.v);
    },
    directionAt: (time, y, x) => {
      const speed = speedGrid?.[time]?.[y]?.[x];
      const direction = dirGrid?.[time]?.[y]?.[x];
      if (typeof speed === 'number' && typeof direction === 'number') {
        return normalizeDegrees(direction);
      }
      if (!components(time, y, x)) {
        return 0;
      }
      const toward = (Math.atan2(scratch.u, scratch.v) * 180) / Math.PI;
      return normalizeDegrees(kind === 'current' ? toward : toward + 180);
    },
  };
}

function forecastFromTimeGrid(input: {
  regionId: string;
  model: string;
  modelRunAt: string;
  fetchedAt: string;
  kind: 'wind' | 'current';
  grid: TimeVectorGrid;
}): NeutralForecast | null {
  const kept = input.grid.times.flatMap((time, index) => {
    const rows = input.grid.cells[index] ?? [];
    if (!rows.some((row) => row.some((cell) => cell))) {
      return [];
    }
    return [{ time, rows: rows.map((row) => row.map((cell) => sampleFor(input.kind, cell))) }];
  });
  const last = kept[kept.length - 1];
  if (!last) {
    return null;
  }
  const validUntil = new Date(Date.parse(last.time) + FORECAST_STEP_MS)
    .toISOString()
    .replace('.000Z', 'Z');
  const forecast: NeutralForecast = {
    regionId: input.regionId,
    providerId: DMI_PROVIDER_ID,
    model: input.model,
    modelRunAt: input.modelRunAt,
    fetchedAt: input.fetchedAt,
    expiresAt: validUntil,
    license: DMI_LICENSE,
    licenseUrl: DMI_LICENSE_URL,
    attribution: DMI_ATTRIBUTION,
    timeAxis: kept.map((step) => step.time),
    geometry: {
      kind: 'grid',
      latitudes: input.grid.latitudes,
      longitudes: input.grid.longitudes,
      samples: kept.map((step) => step.rows),
    },
  };
  assertNeutralForecast(forecast);
  return forecast;
}

function sampleFor(
  kind: 'wind' | 'current',
  cell: TimeVectorGrid['cells'][number][number][number],
): ForecastSample {
  if (!cell) {
    return {};
  }
  const vector = {
    directionDegrees: cell.directionDegrees,
    speed: cell.speed,
    unit: 'm/s' as const,
  };
  return kind === 'wind' ? { wind: vector } : { current: vector };
}
