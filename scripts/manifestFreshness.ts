/**
 * Decide whether a scheduled Pages build should call DMI.
 * A manifest younger than two hours is left in place. One older than six hours
 * is still rebuilt, and the log carries a warning the CI watch can see.
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PAGES_MANIFEST_URL = 'https://jsnielsendk.github.io/sejl-sikkert-data/manifest.json';

export const FRESH_MS = 2 * 60 * 60 * 1000;

export const STALE_WARN_MS = 6 * 60 * 60 * 1000;

export type ManifestDecision = {
  skip: boolean;
  warn: boolean;
  ageMs: number | null;
  reason: string;
};

export function decideManifestFreshness(input: {
  generatedAt: string | null;
  nowMs: number;
  freshMs?: number;
  warnMs?: number;
}): ManifestDecision {
  const freshMs = input.freshMs ?? FRESH_MS;
  const warnMs = input.warnMs ?? STALE_WARN_MS;
  if (!input.generatedAt) {
    return { skip: false, warn: false, ageMs: null, reason: 'manifest unavailable; building' };
  }
  const generated = Date.parse(input.generatedAt);
  if (Number.isNaN(generated)) {
    return {
      skip: false,
      warn: false,
      ageMs: null,
      reason: 'manifest generatedAt is not a time; building',
    };
  }
  const ageMs = input.nowMs - generated;
  if (ageMs < freshMs) {
    return {
      skip: true,
      warn: false,
      ageMs,
      reason: 'manifest is younger than 2 hours; skipping build and deploy',
    };
  }
  if (ageMs > warnMs) {
    return {
      skip: false,
      warn: true,
      ageMs,
      reason: 'manifest is older than 6 hours; building',
    };
  }
  return { skip: false, warn: false, ageMs, reason: 'manifest is due for a refresh; building' };
}

export async function readGeneratedAt(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { generatedAt?: unknown };
    return typeof body.generatedAt === 'string' ? body.generatedAt : null;
  } catch {
    return null;
  }
}

export async function reportManifestFreshness(input?: {
  url?: string;
  nowMs?: number;
  outputPath?: string;
  log?: (line: string) => void;
}): Promise<ManifestDecision> {
  const log = input?.log ?? ((line: string) => console.log(line));
  const generatedAt = await readGeneratedAt(input?.url ?? PAGES_MANIFEST_URL);
  const decision = decideManifestFreshness({
    generatedAt,
    nowMs: input?.nowMs ?? Date.now(),
  });
  log(decision.reason);
  if (decision.ageMs !== null) {
    log(`manifest ageMs=${decision.ageMs} generatedAt=${generatedAt}`);
  }
  if (decision.warn && generatedAt && decision.ageMs !== null) {
    const hours = (decision.ageMs / (60 * 60 * 1000)).toFixed(1);
    log(`::warning::MANIFEST_STALE generatedAt=${generatedAt} ageHours=${hours}`);
  }
  const outputPath = input?.outputPath ?? process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, `skip=${decision.skip ? 'true' : 'false'}\n`);
  }
  return decision;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  reportManifestFreshness().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`manifest freshness check failed: ${message}`);
    process.exitCode = 1;
  });
}
