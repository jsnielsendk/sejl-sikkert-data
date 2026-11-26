/**
 * One decision for every build trigger except workflow_dispatch force=true.
 * A newer DMI model run builds. The same run builds only when the manifest is
 * older than 12 hours, unreadable, or timestamped in the future.
 * If DMI does not answer, fall back to the manifest age: build at 2 hours or more.
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseModelRunId } from '../src/app/client.ts';
import {
  FRESH_MS,
  PAGES_MANIFEST_URL,
  STALE_WARN_MS,
  decideManifestFreshness,
  publishedManifestUrl,
} from './manifestFreshness.ts';

export const SAFETY_MS = 12 * 60 * 60 * 1000;

export const DMI_MODELS = ['harmonie_dini_sf', 'dkss_nsbs'] as const;

export type DmiModel = (typeof DMI_MODELS)[number];

export function instancesUrl(model: DmiModel): string {
  return `https://opendataapi.dmi.dk/v1/forecastedr/collections/${model}/instances`;
}

export type ManifestModelRun = {
  model: string;
  modelRunAt: string;
};

export type DmiRun = {
  model: DmiModel;
  /** Latest parsed model-run time, or null when this model did not answer. */
  modelRunAt: string | null;
  bytes: number;
};

export type BuildDecision = {
  build: boolean;
  warnFuture: boolean;
  warnStale: boolean;
  warnDmi: boolean;
  reason: string;
  lines: string[];
};

function manifestRunAt(runs: readonly ManifestModelRun[], model: string): string | null {
  const match = runs.find((run) => run.model === model && run.modelRunAt.trim() !== '');
  return match ? match.modelRunAt : null;
}

function isNewer(dmiIso: string, manifestIso: string | null): boolean {
  const dmiMs = Date.parse(dmiIso);
  if (Number.isNaN(dmiMs)) {
    return false;
  }
  if (!manifestIso) {
    return true;
  }
  const manifestMs = Date.parse(manifestIso);
  if (Number.isNaN(manifestMs)) {
    return true;
  }
  return dmiMs > manifestMs;
}

/** Latest model-run id in an EDR instances document. The first row is not trusted. */
export function latestInstanceRun(payload: unknown): string | null {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && 'instances' in payload
      ? (payload as { instances?: unknown }).instances
      : null;
  if (!Array.isArray(list)) {
    return null;
  }
  let bestMs = Number.NEGATIVE_INFINITY;
  let bestIso: string | null = null;
  for (const item of list) {
    if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string') {
      continue;
    }
    const parsed = parseModelRunId(item.id);
    if (!parsed) {
      continue;
    }
    if (parsed.getTime() > bestMs) {
      bestMs = parsed.getTime();
      bestIso = parsed.toISOString();
    }
  }
  return bestIso;
}

export function decideBuild(input: {
  nowMs: number;
  generatedAt: string | null;
  manifestModelRuns: readonly ManifestModelRun[];
  dmi: readonly DmiRun[] | null;
  force?: boolean;
}): BuildDecision {
  if (input.force) {
    return {
      build: true,
      warnFuture: false,
      warnStale: false,
      warnDmi: false,
      reason: 'BUILD force',
      lines: ['::notice::BUILD force'],
    };
  }

  const age = decideManifestFreshness({ generatedAt: input.generatedAt, nowMs: input.nowMs });
  const future = age.ageMs !== null && age.ageMs < 0;
  const stale = age.ageMs !== null && age.ageMs > STALE_WARN_MS;
  const unreadable = age.ageMs === null;
  const safety = age.ageMs !== null && age.ageMs >= SAFETY_MS;

  const lines: string[] = [];
  const byModel = new Map<DmiModel, DmiRun>();
  for (const run of input.dmi ?? []) {
    byModel.set(run.model, run);
  }
  let dmiFailed = input.dmi === null;
  let newer = false;
  for (const model of DMI_MODELS) {
    const run = byModel.get(model);
    const dmiAt = run?.modelRunAt ?? null;
    const manifestAt = manifestRunAt(input.manifestModelRuns, model);
    if (!dmiAt) {
      dmiFailed = true;
    } else if (isNewer(dmiAt, manifestAt)) {
      newer = true;
    }
    lines.push(
      `::notice::${model} dmi=${dmiAt ?? 'unavailable'} manifest=${manifestAt ?? 'missing'} bytes=${run?.bytes ?? 0}`,
    );
  }

  if (unreadable) {
    lines.push('::notice::BUILD manifest unreadable');
    return {
      build: true,
      warnFuture: false,
      warnStale: false,
      warnDmi: dmiFailed,
      reason: 'BUILD manifest unreadable',
      lines,
    };
  }

  if (future) {
    lines.push('::warning::MANIFEST_FUTURE');
    lines.push('::notice::BUILD manifest timestamp is in the future');
    return {
      build: true,
      warnFuture: true,
      warnStale: false,
      warnDmi: dmiFailed,
      reason: 'BUILD manifest timestamp is in the future',
      lines,
    };
  }

  if (dmiFailed) {
    lines.push('::warning::DMI model run unavailable; using manifest age');
    const build = age.ageMs !== null && age.ageMs >= FRESH_MS;
    if (stale) {
      lines.push('::warning::MANIFEST_STALE');
    }
    lines.push(`::notice::${build ? 'BUILD' : 'SKIP'} dmi unavailable ageMs=${age.ageMs}`);
    return {
      build,
      warnFuture: false,
      warnStale: stale,
      warnDmi: true,
      reason: `${build ? 'BUILD' : 'SKIP'} dmi unavailable ageMs=${age.ageMs}`,
      lines,
    };
  }

  if (newer) {
    if (stale) {
      lines.push('::warning::MANIFEST_STALE');
    }
    lines.push('::notice::BUILD newer model run');
    return {
      build: true,
      warnFuture: false,
      warnStale: stale,
      warnDmi: false,
      reason: 'BUILD newer model run',
      lines,
    };
  }

  if (safety) {
    lines.push('::warning::MANIFEST_STALE');
    lines.push(`::notice::BUILD manifest ageMs=${age.ageMs} safety`);
    return {
      build: true,
      warnFuture: false,
      warnStale: true,
      warnDmi: false,
      reason: `BUILD manifest ageMs=${age.ageMs} safety`,
      lines,
    };
  }

  if (stale) {
    lines.push('::warning::MANIFEST_STALE');
  }
  lines.push(`::notice::SKIP same model run ageMs=${age.ageMs}`);
  return {
    build: false,
    warnFuture: false,
    warnStale: stale,
    warnDmi: false,
    reason: `SKIP same model run ageMs=${age.ageMs}`,
    lines,
  };
}

type ManifestBody = {
  generatedAt?: unknown;
  modelRuns?: unknown;
};

export async function readPublishedManifest(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ generatedAt: string | null; modelRuns: ManifestModelRun[] } | null> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as ManifestBody;
    const generatedAt = typeof body.generatedAt === 'string' ? body.generatedAt : null;
    const modelRuns: ManifestModelRun[] = [];
    if (Array.isArray(body.modelRuns)) {
      for (const item of body.modelRuns) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const model = 'model' in item && typeof item.model === 'string' ? item.model : '';
        const modelRunAt =
          'modelRunAt' in item && typeof item.modelRunAt === 'string' ? item.modelRunAt : '';
        if (model !== '' && modelRunAt !== '') {
          modelRuns.push({ model, modelRunAt });
        }
      }
    }
    return { generatedAt, modelRuns };
  } catch {
    return null;
  }
}

export async function readDmiRun(
  model: DmiModel,
  fetchImpl: typeof fetch = fetch,
): Promise<DmiRun> {
  const url = instancesUrl(model);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'sejl-sikkert-data/1.0' },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      return { model, modelRunAt: null, bytes: Buffer.byteLength(text) };
    }
    return {
      model,
      modelRunAt: latestInstanceRun(JSON.parse(text) as unknown),
      bytes: Buffer.byteLength(text),
    };
  } catch {
    return { model, modelRunAt: null, bytes: 0 };
  }
}

export async function reportBuildDecision(input?: {
  manifestUrl?: string;
  nowMs?: number;
  force?: boolean;
  fetchImpl?: typeof fetch;
  outputPath?: string;
  log?: (line: string) => void;
  dmi?: readonly DmiRun[] | null;
}): Promise<BuildDecision> {
  const log = input?.log ?? ((line: string) => console.log(line));
  const nowMs = input?.nowMs ?? Date.now();
  const fetchImpl = input?.fetchImpl ?? fetch;
  const manifest = await readPublishedManifest(
    input?.manifestUrl ??
      publishedManifestUrl({
        nowMs,
        runId: process.env.GITHUB_RUN_ID,
      }),
    fetchImpl,
  );
  const dmi =
    input?.dmi !== undefined
      ? input.dmi
      : await Promise.all(DMI_MODELS.map((model) => readDmiRun(model, fetchImpl)));
  const decision = decideBuild({
    nowMs,
    generatedAt: manifest?.generatedAt ?? null,
    manifestModelRuns: manifest?.modelRuns ?? [],
    dmi,
    force: input?.force ?? false,
  });
  for (const line of decision.lines) {
    log(line);
  }
  const outputPath = input?.outputPath ?? process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, `skip=${decision.build ? 'false' : 'true'}\n`);
  }
  return decision;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  const force = process.env.BUILD_FORCE === 'true';
  reportBuildDecision({ force }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`build decision failed: ${message}`);
    process.exitCode = 1;
  });
}

export { PAGES_MANIFEST_URL };
