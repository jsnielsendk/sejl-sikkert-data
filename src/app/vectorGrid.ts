/**
 * Copied from jsnielsendk/sejl-sikkert-app@aa67b261981f151cc7869945ec0bcfb0f8917719
 * Source: src/weather/vectorGrid.ts
 * The pipeline uses strongestBoxGrid (10 by 10, strongest vector per cell).
 * gridFromTimedSamples is the same commit's per-point reducer and is kept with it.
 */

export const VISIBLE_AXIS_MAX = 10;

export type RawVector = {
  latitude: number;
  longitude: number;
  speed: number;
  directionDegrees: number;
};

export type GridBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

/** Rectangular field. `cells[latitudeIndex][longitudeIndex]` is null on land or gaps. */
export type VectorGrid = {
  latitudes: number[];
  longitudes: number[];
  cells: (RawVector | null)[][];
};

function axisKey(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function vectorKey(latitude: number, longitude: number): string {
  return `${axisKey(latitude)}:${axisKey(longitude)}`;
}

function finiteVector(sample: RawVector): boolean {
  return (
    Number.isFinite(sample.latitude) &&
    Number.isFinite(sample.longitude) &&
    Number.isFinite(sample.speed) &&
    Number.isFinite(sample.directionDegrees)
  );
}

export type TimedRawVector = RawVector & { time: string };

/** One field per stored hour. `cells[time][latitude][longitude]`. */
export type TimeVectorGrid = {
  times: string[];
  latitudes: number[];
  longitudes: number[];
  cells: (RawVector | null)[][][];
};

/** Stored forecast steps are three hours apart, through 48 hours. */
export const FORECAST_STEP_MS = 3 * 60 * 60 * 1000;

/**
 * Split `bounds` into at most `maxAxis` by `maxAxis` bins and keep the strongest
 * sample in each bin. Reads numbers through callbacks so the caller does not
 * allocate an object per raw cell. Every hour uses the same bin centres.
 */
export function strongestBoxGrid(input: {
  times: readonly string[];
  yCount: number;
  xCount: number;
  latitudeAt: (y: number, x: number) => number;
  longitudeAt: (y: number, x: number) => number;
  speedAt: (time: number, y: number, x: number) => number;
  directionAt: (time: number, y: number, x: number) => number;
  bounds: GridBounds;
  maxAxis?: number;
}): TimeVectorGrid {
  const max = input.maxAxis ?? VISIBLE_AXIS_MAX;
  const box = orderedBounds(input.bounds);
  const latSpan = Math.max(box.north - box.south, 1e-9);
  const lonSpan = Math.max(box.east - box.west, 1e-9);
  const dLat = latSpan / max;
  const dLon = lonSpan / max;
  const latitudes = Array.from({ length: max }, (_, index) => box.south + (index + 0.5) * dLat);
  const longitudes = Array.from({ length: max }, (_, index) => box.west + (index + 0.5) * dLon);
  const bestSpeed = new Float64Array(max * max);
  const bestDirection = new Float64Array(max * max);
  const cells: (RawVector | null)[][][] = [];
  for (let time = 0; time < input.times.length; time += 1) {
    bestSpeed.fill(Number.NaN);
    for (let y = 0; y < input.yCount; y += 1) {
      for (let x = 0; x < input.xCount; x += 1) {
        const latitude = input.latitudeAt(y, x);
        const longitude = input.longitudeAt(y, x);
        if (
          latitude < box.south ||
          latitude > box.north ||
          longitude < box.west ||
          longitude > box.east
        ) {
          continue;
        }
        const speed = input.speedAt(time, y, x);
        if (!Number.isFinite(speed)) {
          continue;
        }
        let iy = Math.floor(((latitude - box.south) / latSpan) * max);
        let ix = Math.floor(((longitude - box.west) / lonSpan) * max);
        if (iy >= max) {
          iy = max - 1;
        } else if (iy < 0) {
          iy = 0;
        }
        if (ix >= max) {
          ix = max - 1;
        } else if (ix < 0) {
          ix = 0;
        }
        const slot = iy * max + ix;
        const chosen = bestSpeed[slot] ?? Number.NaN;
        if (!Number.isFinite(chosen) || speed > chosen) {
          bestSpeed[slot] = speed;
          bestDirection[slot] = input.directionAt(time, y, x);
        }
      }
    }
    const rows: (RawVector | null)[][] = [];
    for (let iy = 0; iy < max; iy += 1) {
      const row: (RawVector | null)[] = [];
      for (let ix = 0; ix < max; ix += 1) {
        const speed = bestSpeed[iy * max + ix] ?? Number.NaN;
        if (!Number.isFinite(speed)) {
          row.push(null);
          continue;
        }
        row.push({
          latitude: latitudes[iy] ?? 0,
          longitude: longitudes[ix] ?? 0,
          speed,
          directionDegrees: bestDirection[iy * max + ix] ?? 0,
        });
      }
      rows.push(row);
    }
    cells.push(rows);
  }
  return { times: [...input.times], latitudes, longitudes, cells };
}

/** One cell per position and hour. A repeated sample keeps the stronger vector. */
export function gridFromTimedSamples(samples: readonly TimedRawVector[]): TimeVectorGrid {
  const byTime = new Map<string, TimedRawVector[]>();
  for (const sample of samples) {
    if (
      !finiteVector(sample) ||
      sample.time.trim() === '' ||
      Number.isNaN(Date.parse(sample.time))
    ) {
      continue;
    }
    const list = byTime.get(sample.time);
    if (list) {
      list.push(sample);
    } else {
      byTime.set(sample.time, [sample]);
    }
  }
  const times = [...byTime.keys()].sort((left, right) => Date.parse(left) - Date.parse(right));
  const slices = times.map((time) => gridFromSamples(byTime.get(time) ?? []));
  const latitudes = [...new Set(slices.flatMap((slice) => slice.latitudes))].sort((a, b) => a - b);
  const longitudes = [...new Set(slices.flatMap((slice) => slice.longitudes))].sort(
    (a, b) => a - b,
  );
  return {
    times,
    latitudes,
    longitudes,
    cells: slices.map((slice) => {
      const at = new Map<string, RawVector>();
      slice.latitudes.forEach((latitude, y) => {
        slice.longitudes.forEach((longitude, x) => {
          const cell = slice.cells[y]?.[x];
          if (cell) {
            at.set(vectorKey(latitude, longitude), cell);
          }
        });
      });
      return latitudes.map((latitude) =>
        longitudes.map((longitude) => at.get(vectorKey(latitude, longitude)) ?? null),
      );
    }),
  };
}

/** One cell per distinct position. A repeated position keeps the stronger vector. */
export function gridFromSamples(samples: readonly RawVector[]): VectorGrid {
  const byLat = new Map<number, Map<number, RawVector>>();
  for (const sample of samples) {
    if (!finiteVector(sample)) {
      continue;
    }
    const latitude = axisKey(sample.latitude);
    const longitude = axisKey(sample.longitude);
    let row = byLat.get(latitude);
    if (!row) {
      row = new Map();
      byLat.set(latitude, row);
    }
    const placed: RawVector = { ...sample, latitude, longitude };
    const previous = row.get(longitude);
    if (!previous || placed.speed > previous.speed) {
      row.set(longitude, placed);
    }
  }
  const latitudes = [...byLat.keys()].sort((a, b) => a - b);
  const longitudes = [...new Set([...byLat.values()].flatMap((row) => [...row.keys()]))].sort(
    (a, b) => a - b,
  );
  return {
    latitudes,
    longitudes,
    cells: latitudes.map((latitude) => {
      const row = byLat.get(latitude);
      return longitudes.map((longitude) => row?.get(longitude) ?? null);
    }),
  };
}

function orderedBounds(bounds: GridBounds): {
  west: number;
  east: number;
  south: number;
  north: number;
} {
  return {
    west: Math.min(bounds.west, bounds.east),
    east: Math.max(bounds.west, bounds.east),
    south: Math.min(bounds.south, bounds.north),
    north: Math.max(bounds.south, bounds.north),
  };
}
