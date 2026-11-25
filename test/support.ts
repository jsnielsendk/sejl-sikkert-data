import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DmiResponse } from '../src/dmi/serial';

export const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'dmi-wind.json',
);

export function readFixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as unknown;
}

export function jsonResponse(status: number, body: unknown): DmiResponse {
  return {
    status,
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

export function coverageBody(url: string): unknown {
  const parsed = new URL(url);
  const bbox = (parsed.searchParams.get('bbox') ?? '').split(',').map(Number);
  const [x0, y0, x1, y1] = bbox;
  const datetime = parsed.searchParams.get('datetime') ?? '';
  const [startIso, endIso] = datetime.split('/');
  const start = Date.parse(startIso ?? '');
  const end = Date.parse(endIso ?? startIso ?? '');
  const times: string[] = [];
  for (let time = start; time <= end; time += 3 * 60 * 60 * 1000) {
    times.push(new Date(time).toISOString().replace('.000Z', 'Z'));
  }
  const xs = [x0, (x0 + x1) / 2, x1];
  const ys = [y0, (y0 + y1) / 2, y1];
  const values: number[] = [];
  for (let time = 0; time < times.length; time += 1) {
    for (let y = 0; y < ys.length; y += 1) {
      for (let x = 0; x < xs.length; x += 1) {
        values.push(1);
      }
    }
  }
  const names = (parsed.searchParams.get('parameter-name') ?? '').split(',');
  const ranges: Record<string, unknown> = {};
  for (const name of names) {
    ranges[name] = {
      type: 'NdArray',
      shape: [times.length, ys.length, xs.length],
      values,
    };
  }
  return {
    type: 'Coverage',
    domain: {
      type: 'Domain',
      axes: {
        t: { values: times },
        x: { values: xs },
        y: { values: ys },
      },
    },
    ranges,
  };
}

export function scriptedHttp(input?: {
  onCube?: (url: string, attempt: number) => DmiResponse | null;
}): { http: (url: string) => Promise<DmiResponse>; calls: string[] } {
  const calls: string[] = [];
  const cubeAttempts = new Map<string, number>();
  return {
    calls,
    http: (url) => {
      calls.push(url);
      if (url.includes('/instances') && !url.includes('/cube')) {
        return Promise.resolve(
          jsonResponse(200, { instances: [{ id: '2026-11-25T150000Z' }] }),
        );
      }
      const attempt = (cubeAttempts.get(url) ?? 0) + 1;
      cubeAttempts.set(url, attempt);
      const custom = input?.onCube?.(url, attempt);
      if (custom) {
        return Promise.resolve(custom);
      }
      return Promise.resolve(jsonResponse(200, coverageBody(url)));
    },
  };
}
