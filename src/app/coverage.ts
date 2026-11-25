/**
 * Copied from jsnielsendk/sejl-sikkert-app@aa67b261981f151cc7869945ec0bcfb0f8917719
 * Source: src/features/weather/dmi/coverage.ts
 * parseCoverage and mergeCoverageGrids are the parts the forecast conversion reads.
 */

export type CoverageUnit = 'degree' | 'kilometre' | 'metre';

/** One numeric parameter on a [time][y][x] grid. Null is a missing sample. */
export type CoverageGrid = {
  times: string[];
  xs: number[];
  ys: number[];
  unit: CoverageUnit;
  parameters: Record<string, (number | null)[][][]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function axisNumbers(axis: unknown): number[] | null {
  if (!isRecord(axis)) {
    return null;
  }
  if (Array.isArray(axis.values) && axis.values.every((value) => typeof value === 'number')) {
    return axis.values as number[];
  }
  const { start, stop, num } = axis;
  if (typeof start !== 'number' || typeof stop !== 'number' || typeof num !== 'number') {
    return null;
  }
  if (!Number.isFinite(num) || num < 1) {
    return null;
  }
  const count = Math.trunc(num);
  if (count === 1) {
    return [start];
  }
  const step = (stop - start) / (count - 1);
  return Array.from({ length: count }, (_, index) => start + step * index);
}

function axisTimes(axis: unknown): string[] | null {
  if (!isRecord(axis) || !Array.isArray(axis.values) || axis.values.length === 0) {
    return null;
  }
  const times: string[] = [];
  for (const value of axis.values) {
    if (typeof value !== 'string') {
      return null;
    }
    times.push(value.replace('.000Z', 'Z'));
  }
  return times;
}

function coordinateUnit(xs: number[], ys: number[]): CoverageUnit {
  const max = Math.max(
    ...xs.map((value) => Math.abs(value)),
    ...ys.map((value) => Math.abs(value)),
  );
  if (max <= 180) {
    return 'degree';
  }
  if (max <= 20_000) {
    return 'kilometre';
  }
  return 'metre';
}

function readSlab(
  values: readonly unknown[],
  shape: readonly number[],
  timeCount: number,
  xCount: number,
  yCount: number,
): (number | null)[][][] | null {
  const [s0, s1, s2] = shape;
  if (s0 !== timeCount) {
    return null;
  }
  const yMajor = s1 === yCount && s2 === xCount;
  const xMajor = s1 === xCount && s2 === yCount;
  if (!yMajor && !xMajor) {
    return null;
  }
  if (values.length !== s0 * s1 * s2) {
    return null;
  }
  const grid: (number | null)[][][] = [];
  for (let time = 0; time < timeCount; time += 1) {
    const rows: (number | null)[][] = [];
    for (let y = 0; y < yCount; y += 1) {
      const row: (number | null)[] = [];
      for (let x = 0; x < xCount; x += 1) {
        const index = yMajor ? (time * yCount + y) * xCount + x : (time * xCount + x) * yCount + y;
        const value = values[index];
        row.push(typeof value === 'number' && Number.isFinite(value) ? value : null);
      }
      rows.push(row);
    }
    grid.push(rows);
  }
  return grid;
}

export function parseCoverage(raw: unknown): CoverageGrid | null {
  if (!isRecord(raw) || !isRecord(raw.domain) || !isRecord(raw.domain.axes)) {
    return null;
  }
  const axes = raw.domain.axes;
  const times = axisTimes(axes.t);
  const xs = axisNumbers(axes.x);
  const ys = axisNumbers(axes.y);
  if (!times || !xs || !ys) {
    return null;
  }
  const parameters: CoverageGrid['parameters'] = {};
  if (isRecord(raw.ranges)) {
    for (const [name, range] of Object.entries(raw.ranges)) {
      if (!isRecord(range) || !Array.isArray(range.values) || !Array.isArray(range.shape)) {
        continue;
      }
      const shape = range.shape.filter((value): value is number => typeof value === 'number');
      if (shape.length !== 3) {
        continue;
      }
      const slab = readSlab(range.values, shape, times.length, xs.length, ys.length);
      if (slab) {
        parameters[name] = slab;
      }
    }
  }
  return { times, xs, ys, unit: coordinateUnit(xs, ys), parameters };
}

export function mergeCoverageGrids(parts: readonly CoverageGrid[]): CoverageGrid | null {
  const grids = parts.filter((part) => part.times.length > 0 && part.xs.length > 0);
  const first = grids[0];
  if (!first) {
    return null;
  }
  const same = grids.filter(
    (part) => part.xs.length === first.xs.length && part.ys.length === first.ys.length,
  );
  if (same.length === 1) {
    return first;
  }
  const names = Object.keys(first.parameters);
  const times: string[] = [];
  const slabs: Record<string, (number | null)[][][]> = {};
  for (const name of names) {
    slabs[name] = [];
  }
  for (const part of same) {
    part.times.forEach((time, timeIndex) => {
      if (times.includes(time)) {
        return;
      }
      times.push(time);
      for (const name of names) {
        const source = part.parameters[name]?.[timeIndex];
        const row = source
          ? source.map((line) => line.slice())
          : first.ys.map(() => first.xs.map(() => null));
        slabs[name]?.push(row);
      }
    });
  }
  const order = times
    .map((time, index) => ({ time, index }))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const sortedTimes = order.map((item) => item.time);
  const sorted: CoverageGrid['parameters'] = {};
  for (const name of names) {
    const source = slabs[name] ?? [];
    sorted[name] = order.map((item) => source[item.index] ?? []);
  }
  return { times: sortedTimes, xs: first.xs, ys: first.ys, unit: first.unit, parameters: sorted };
}
