/**
 * Fetch every configured tile from DMI, convert it with the app's forecast
 * logic, and publish one JSON file per tile and kind plus manifest.json.
 * A failed tile removes the staging directory and leaves any previous out/ in place.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  coverageUrl,
  crs84Bbox,
  DMI_EDR_BASE,
  forecastWindow,
  formatUtc,
  pickModelRun,
} from './app/client';
import { mergeCoverageGrids, parseCoverage, type CoverageGrid } from './app/coverage';
import { forecastFromCoverage } from './app/convert';
import { nativeBboxKm } from './app/lambert';
import type { NeutralForecast } from './app/types';
import { FORECAST_STEP_MS } from './app/vectorGrid';
import {
  currentCollection,
  DATA_ATTRIBUTION,
  DATA_LICENSE,
  DATA_LICENSE_URL,
  DKSS_IDW_COLLECTION,
  DKSS_NSBS_COLLECTION,
  FORMAT_VERSION,
  HARMONIE_COLLECTION,
  pauseMsFromEnv,
  tilesFromConfig,
  type Tile,
} from './config';
import {
  createSerialClient,
  defaultHttp,
  delay,
  isRetryableStatus,
  type DmiHttp,
  type FetchStats,
} from './dmi/serial';
import { serializeTile } from './serializeTile';

export type ManifestTile = {
  id: string;
  kind: 'wind' | 'current';
  bbox: Tile['bbox'];
  file: string;
  bytes: number;
  sha256: string;
  model: string;
  modelRunAt: string;
};

export type Manifest = {
  generatedAt: string;
  formatVersion: string;
  attribution: string;
  license: string;
  licenseUrl: string;
  modelRuns: { kind: 'wind' | 'current'; model: string; modelRunAt: string }[];
  tiles: ManifestTile[];
};

export type BuildReport = {
  calls: number;
  saw429: boolean;
  durationMs: number;
  bytes: number;
  outDir: string;
};

export type BuildOptions = {
  outDir: string;
  now?: Date;
  tiles?: readonly Tile[];
  http?: DmiHttp;
  sleep?: (ms: number) => Promise<void>;
  pauseMs?: number;
};

type ModelRun = { id: string; modelRunAt: string };

class DmiStatusError extends Error {
  readonly status: number;

  constructor(status: number, url: string) {
    super(`DMI HTTP ${status} for ${url}`);
    this.name = 'DmiStatusError';
    this.status = status;
  }
}

function expectedSteps(start: Date): string[] {
  const steps: string[] = [];
  for (let hour = 0; hour <= 48; hour += 3) {
    steps.push(formatUtc(new Date(start.getTime() + hour * 60 * 60 * 1000)));
  }
  return steps;
}

function assertSteps(timeAxis: readonly string[], start: Date): void {
  const got = new Set(timeAxis.map((iso) => formatUtc(new Date(Date.parse(iso)))));
  const missing = expectedSteps(start).filter((step) => !got.has(step));
  if (missing.length > 0) {
    throw new Error(`Forecast is missing steps ${missing.join(', ')}`);
  }
}

function publish(forecast: NeutralForecast, start: Date): NeutralForecast {
  assertSteps(forecast.timeAxis, start);
  return {
    ...forecast,
    license: DATA_LICENSE,
    licenseUrl: DATA_LICENSE_URL,
    attribution: DATA_ATTRIBUTION,
  };
}

function axisCenters(min: number, max: number): number[] {
  const span = Math.max(max - min, 1e-9);
  const step = span / 10;
  return Array.from({ length: 10 }, (_, index) => min + (index + 0.5) * step);
}

function gridHasSteps(grid: CoverageGrid, start: Date): boolean {
  const got = new Set(grid.times.map((iso) => formatUtc(new Date(Date.parse(iso)))));
  return expectedSteps(start).every((step) => got.has(step));
}

/** A sea model can return a cube whose every sample is on land. The file still has the 17 steps. */
function withAllSteps(
  forecast: NeutralForecast | null,
  start: Date,
  tile: Tile,
  run: ModelRun,
  model: string,
  fetchedAt: string,
): NeutralForecast {
  const steps = expectedSteps(start);
  const emptyRows = (latitudes: readonly number[], longitudes: readonly number[]) =>
    latitudes.map(() => longitudes.map(() => ({})));
  if (!forecast || forecast.geometry.kind !== 'grid') {
    const latitudes = axisCenters(tile.bbox.south, tile.bbox.north);
    const longitudes = axisCenters(tile.bbox.west, tile.bbox.east);
    return publish(
      {
        regionId: 'dk',
        providerId: 'dmi-edr',
        model,
        modelRunAt: run.modelRunAt,
        fetchedAt,
        expiresAt: formatUtc(new Date(Date.parse(steps[steps.length - 1] ?? '') + FORECAST_STEP_MS)),
        license: DATA_LICENSE,
        licenseUrl: DATA_LICENSE_URL,
        attribution: DATA_ATTRIBUTION,
        timeAxis: steps,
        geometry: {
          kind: 'grid',
          latitudes,
          longitudes,
          samples: steps.map(() => emptyRows(latitudes, longitudes)),
        },
      },
      start,
    );
  }
  const { latitudes, longitudes, samples: source } = forecast.geometry;
  const byTime = new Map(
    forecast.timeAxis.map((time, index) => [formatUtc(new Date(Date.parse(time))), index]),
  );
  const samples = steps.map((step) => {
    const index = byTime.get(step);
    return index === undefined ? emptyRows(latitudes, longitudes) : source[index] ?? emptyRows(latitudes, longitudes);
  });
  return publish(
    {
      ...forecast,
      timeAxis: steps,
      geometry: { kind: 'grid', latitudes, longitudes, samples },
    },
    start,
  );
}

export async function buildDataset(options: BuildOptions): Promise<BuildReport> {
  const started = Date.now();
  const now = options.now ?? new Date();
  const tiles = options.tiles ?? tilesFromConfig();
  const window = forecastWindow(now);
  const stats: FetchStats = { calls: 0, saw429: false };
  const get = createSerialClient({
    http: options.http ?? defaultHttp,
    sleep: options.sleep ?? delay,
    stats,
    pauseMs: options.pauseMs ?? pauseMsFromEnv(),
  });
  const runs = new Map<string, ModelRun>();
  const resolved = path.resolve(options.outDir);
  const staging = `${resolved}.partial`;
  const backup = `${resolved}.bak`;

  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  try {
    const written: ManifestTile[] = [];
    for (const tile of tiles) {
      const wind = await loadWind(tile);
      written.push(await writeTile(staging, tile, 'wind', wind));
      const current = await loadCurrent(tile);
      written.push(await writeTile(staging, tile, 'current', current));
      if (process.env.VITEST !== 'true') {
        console.error(`tile ${tile.id} wind=${wind.model} current=${current.model}`);
      }
    }
    const manifest = manifestFor(written);
    const manifestJson = JSON.stringify(manifest);
    const indexHtml = pagesIndexHtml();
    await writeFile(path.join(staging, 'manifest.json'), manifestJson);
    await writeFile(path.join(staging, 'index.html'), indexHtml);
    await writeFile(path.join(staging, '.nojekyll'), '');
    await publishStaging(staging, resolved, backup);
    const bytes =
      written.reduce((sum, tile) => sum + tile.bytes, 0) +
      Buffer.byteLength(manifestJson) +
      Buffer.byteLength(indexHtml);
    return {
      calls: stats.calls,
      saw429: stats.saw429,
      durationMs: Date.now() - started,
      bytes,
      outDir: resolved,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  async function modelRun(collection: string): Promise<ModelRun> {
    const cached = runs.get(collection);
    if (cached) {
      return cached;
    }
    const url = `${DMI_EDR_BASE}/${collection}/instances`;
    const response = await get(url);
    if (response.status !== 200) {
      throw new DmiStatusError(response.status, url);
    }
    const picked = pickModelRun(response.json, now);
    if (!picked) {
      throw new Error(`${collection} has no model run from the last 24 hours.`);
    }
    runs.set(collection, picked);
    return picked;
  }

  async function loadCube(input: {
    collection: string;
    instance: string;
    bbox: string;
    parameters: string;
    crs: 'native' | 'crs84';
    start: Date;
    end: Date;
  }): Promise<CoverageGrid> {
    const url = coverageUrl(input);
    const response = await get(url);
    const span = input.end.getTime() - input.start.getTime();
    if (response.status === 413 && span > FORECAST_STEP_MS) {
      const mid = new Date(input.start.getTime() + Math.floor(span / 2));
      mid.setUTCMinutes(0, 0, 0);
      if (mid.getTime() <= input.start.getTime() || mid.getTime() >= input.end.getTime()) {
        throw new Error(`DMI returned 413 and the interval cannot be split: ${url}`);
      }
      const left = await loadCube({ ...input, start: input.start, end: mid });
      const right = await loadCube({ ...input, start: mid, end: input.end });
      const merged = mergeCoverageGrids([left, right]);
      if (!merged) {
        throw new Error(`DMI 413 split could not be merged: ${url}`);
      }
      return merged;
    }
    if (response.status !== 200) {
      throw new DmiStatusError(response.status, url);
    }
    const grid = parseCoverage(response.json);
    if (!grid) {
      throw new Error(`DMI coverage could not be parsed: ${url}`);
    }
    return grid;
  }

  function toForecast(
    grid: CoverageGrid,
    kind: 'wind' | 'current',
    tile: Tile,
    run: ModelRun,
    model: string,
  ): NeutralForecast {
    if (!gridHasSteps(grid, window.start)) {
      throw new Error(`${kind} ${tile.id} (${model}) is missing forecast steps`);
    }
    const fetchedAt = now.toISOString();
    const forecast = forecastFromCoverage({
      grid,
      kind,
      regionId: 'dk',
      model,
      modelRunAt: run.modelRunAt,
      fetchedAt,
      nowMs: now.getTime(),
      earliestMs: window.start.getTime(),
      latestMs: window.end.getTime(),
      bounds: tile.bbox,
    });
    return withAllSteps(forecast, window.start, tile, run, model, fetchedAt);
  }

  async function loadWind(tile: Tile): Promise<NeutralForecast> {
    const run = await modelRun(HARMONIE_COLLECTION);
    const parameterSets = ['wind-10m-u,wind-10m-v', 'wind-speed-10m,wind-dir-10m'];
    let last: Error | null = null;
    for (const parameters of parameterSets) {
      try {
        const grid = await loadCube({
          collection: HARMONIE_COLLECTION,
          instance: run.id,
          bbox: nativeBboxKm(tile.bbox),
          parameters,
          crs: 'native',
          start: window.start,
          end: window.end,
        });
        return toForecast(grid, 'wind', tile, run, HARMONIE_COLLECTION);
      } catch (error) {
        if (error instanceof DmiStatusError && isRetryableStatus(error.status)) {
          throw new Error(`Wind tile ${tile.id} failed: ${error.message}`);
        }
        last = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw new Error(`Wind tile ${tile.id} failed: ${last?.message ?? 'unknown error'}`);
  }

  async function loadCurrent(tile: Tile): Promise<NeutralForecast> {
    const preferred = currentCollection(tile);
    const collections =
      preferred === DKSS_IDW_COLLECTION
        ? [DKSS_IDW_COLLECTION, DKSS_NSBS_COLLECTION]
        : [DKSS_NSBS_COLLECTION];
    let last: Error | null = null;
    for (const collection of collections) {
      try {
        const run = await modelRun(collection);
        const grid = await loadCube({
          collection,
          instance: run.id,
          bbox: crs84Bbox(tile.bbox),
          parameters: 'current-u,current-v',
          crs: 'crs84',
          start: window.start,
          end: window.end,
        });
        return toForecast(grid, 'current', tile, run, collection);
      } catch (error) {
        if (error instanceof DmiStatusError && isRetryableStatus(error.status)) {
          throw new Error(`Current tile ${tile.id} failed: ${error.message}`);
        }
        last = error instanceof Error ? error : new Error(String(error));
        const status = error instanceof DmiStatusError ? error.status : 0;
        if (status === 404 || status === 400) {
          continue;
        }
      }
    }
    throw new Error(`Current tile ${tile.id} failed: ${last?.message ?? 'unknown error'}`);
  }
}

async function writeTile(
  staging: string,
  tile: Tile,
  kind: 'wind' | 'current',
  forecast: NeutralForecast,
): Promise<ManifestTile> {
  const json = serializeTile(forecast);
  const file = path.posix.join(kind, `${tile.id}.json`);
  await mkdir(path.join(staging, kind), { recursive: true });
  await writeFile(path.join(staging, kind, `${tile.id}.json`), json);
  return {
    id: tile.id,
    kind,
    bbox: tile.bbox,
    file,
    bytes: Buffer.byteLength(json),
    sha256: createHash('sha256').update(json).digest('hex'),
    model: forecast.model,
    modelRunAt: forecast.modelRunAt,
  };
}

function pagesIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="da">
<head>
  <meta charset="utf-8">
  <title>sejl-sikkert-data</title>
</head>
<body>
  <h1>sejl-sikkert-data</h1>
  <p>Kompakte vind- og strømfliser for danske farvande. Oversigten ligger i <a href="manifest.json">manifest.json</a>.</p>
  <p>${DATA_ATTRIBUTION}. Dataene er under <a href="${DATA_LICENSE_URL}">${DATA_LICENSE}</a>.</p>
</body>
</html>
`;
}

function manifestFor(tiles: readonly ManifestTile[]): Manifest {
  const seen = new Set<string>();
  const modelRuns: Manifest['modelRuns'] = [];
  for (const tile of tiles) {
    const key = `${tile.kind}|${tile.model}|${tile.modelRunAt}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    modelRuns.push({ kind: tile.kind, model: tile.model, modelRunAt: tile.modelRunAt });
  }
  return {
    generatedAt: formatUtc(new Date()),
    formatVersion: FORMAT_VERSION,
    attribution: DATA_ATTRIBUTION,
    license: DATA_LICENSE,
    licenseUrl: DATA_LICENSE_URL,
    modelRuns,
    tiles: [...tiles],
  };
}

async function publishStaging(staging: string, outDir: string, backup: string): Promise<void> {
  await rm(backup, { recursive: true, force: true });
  const hadPrevious = existsSync(outDir);
  if (hadPrevious) {
    await rename(outDir, backup);
  }
  try {
    await rename(staging, outDir);
  } catch (error) {
    if (hadPrevious) {
      await rename(backup, outDir);
    }
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
}
