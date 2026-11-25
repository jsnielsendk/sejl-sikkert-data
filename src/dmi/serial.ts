/**
 * Serial DMI HTTP. Requests run one at a time with a pause between them.
 * 429 and 5xx are retried with backoff, at most MAX_ATTEMPTS in total.
 */

import { MAX_ATTEMPTS, MAX_RETRY_AFTER_MS, REQUEST_PAUSE_MS, RETRY_DELAYS_MS } from '../config';

export type DmiResponse = {
  status: number;
  body: Uint8Array;
  headers?: { get(name: string): string | null };
};

export type DmiHttp = (url: string) => Promise<DmiResponse>;

export type FetchStats = {
  calls: number;
  saw429: boolean;
};

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function capRetry(ms: number): number {
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

function retryDelayMs(attempt: number, headers?: { get(name: string): string | null }): number {
  const configured = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  const header = headers?.get('retry-after');
  if (!header) {
    return capRetry(configured);
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return capRetry(Math.max(configured, seconds * 1000));
  }
  const when = Date.parse(header);
  if (Number.isNaN(when)) {
    return capRetry(configured);
  }
  return capRetry(Math.max(configured, when - Date.now()));
}

function decodeJson(body: Uint8Array): unknown | null {
  if (body.byteLength === 0) {
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
}

export async function fetchJson(input: {
  url: string;
  http: DmiHttp;
  sleep: (ms: number) => Promise<void>;
  stats: FetchStats;
}): Promise<{ status: number; json: unknown | null }> {
  let lastStatus = 0;
  let lastJson: unknown = null;
  let lastHeaders: DmiResponse['headers'];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    input.stats.calls += 1;
    try {
      const response = await input.http(input.url);
      if (response.status === 429) {
        input.stats.saw429 = true;
      }
      lastStatus = response.status;
      lastJson = decodeJson(response.body);
      lastHeaders = response.headers;
      if (!isRetryableStatus(response.status)) {
        return { status: lastStatus, json: lastJson };
      }
    } catch (error) {
      lastStatus = 0;
      lastJson = null;
      lastHeaders = undefined;
      if (attempt >= MAX_ATTEMPTS - 1) {
        throw error;
      }
    }
    if (attempt < MAX_ATTEMPTS - 1) {
      await input.sleep(retryDelayMs(attempt, lastHeaders));
    }
  }
  return { status: lastStatus, json: lastJson };
}

export function createSerialClient(input: {
  http: DmiHttp;
  sleep: (ms: number) => Promise<void>;
  stats: FetchStats;
  pauseMs?: number;
}): (url: string) => Promise<{ status: number; json: unknown | null }> {
  const pauseMs = input.pauseMs ?? REQUEST_PAUSE_MS;
  let primed = false;
  return async (url) => {
    if (primed && pauseMs > 0) {
      await input.sleep(pauseMs);
    }
    primed = true;
    return fetchJson({
      url,
      http: input.http,
      sleep: input.sleep,
      stats: input.stats,
    });
  };
}

export async function defaultHttp(url: string): Promise<DmiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/prs.coverage+json, application/json;q=0.9',
        'User-Agent': 'sejl-sikkert-data/1.0 (serial; no-api-key)',
      },
      signal: controller.signal,
    });
    return {
      status: response.status,
      body: new Uint8Array(await response.arrayBuffer()),
      headers: { get: (name) => response.headers.get(name) },
    };
  } finally {
    clearTimeout(timer);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
