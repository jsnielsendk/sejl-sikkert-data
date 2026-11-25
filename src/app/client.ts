/**
 * Copied from jsnielsendk/sejl-sikkert-app@aa67b261981f151cc7869945ec0bcfb0f8917719
 * Source: src/features/weather/dmi/client.ts
 * URL shape, forecast window and model-run selection match that commit.
 * This repo's request loop (serial pause, at most 3 attempts) lives in src/dmi/serial.ts.
 */

export const DMI_EDR_BASE = 'https://opendataapi.dmi.dk/v1/forecastedr/collections';

export function formatUtc(date: Date): string {
  return date.toISOString().replace('.000Z', 'Z');
}

/**
 * From the current hour through 48 hours.
 * DMI EDR accepts one RFC 3339 time or an inclusive interval. A comma-separated
 * datetime list and a PT3H stride both return 400, so one cube asks for the
 * whole interval and conversion keeps +0, +3, …, +48.
 */
export function forecastWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 48 * 60 * 60 * 1000);
  return { start, end };
}

/** Previous completed 3-hour cycle. HARMONIE keeps only the last 24 hours of runs. */
export function estimatedRun(now: Date): string {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  const hour = start.getUTCHours();
  start.setUTCHours(hour - (hour % 3) - 3);
  return start.toISOString();
}

export function parseModelRunId(id: string): Date | null {
  const compact = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id);
  if (compact) {
    const parsed = Date.parse(`${compact[1]}T${compact[2]}:${compact[3]}:${compact[4]}Z`);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }
  const parsed = Date.parse(id);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

export function pickModelRun(
  payload: unknown,
  now: Date,
): { id: string; modelRunAt: string } | null {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && 'instances' in payload
      ? (payload as { instances?: unknown }).instances
      : null;
  if (!Array.isArray(list)) {
    return null;
  }
  const runs = list.flatMap((item) => {
    if (!item || typeof item !== 'object' || !('id' in item)) {
      return [];
    }
    const id = String((item as { id: unknown }).id);
    const time = parseModelRunId(id);
    if (!time) {
      return [];
    }
    const age = now.getTime() - time.getTime();
    if (age < 0 || age > 24 * 60 * 60 * 1000) {
      return [];
    }
    return [{ id, time }];
  });
  runs.sort((a, b) => b.time.getTime() - a.time.getTime());
  const newest = runs[0];
  return newest ? { id: newest.id, modelRunAt: newest.time.toISOString() } : null;
}

export function crs84Bbox(bounds: {
  west: number;
  south: number;
  east: number;
  north: number;
}): string {
  const fmt = (value: number) => value.toFixed(4);
  return `${fmt(bounds.west)},${fmt(bounds.south)},${fmt(bounds.east)},${fmt(bounds.north)}`;
}

function queryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => {
      const encoded = encodeURIComponent(value)
        .replaceAll('%2C', ',')
        .replaceAll('%2F', '/')
        .replaceAll('%3A', ':');
      return `${encodeURIComponent(key)}=${encoded}`;
    })
    .join('&');
}

export function coverageUrl(input: {
  collection: string;
  instance: string | null;
  bbox: string;
  parameters: string;
  crs: 'native' | 'crs84';
  start: Date;
  end: Date;
}): string {
  const base = `${DMI_EDR_BASE}/${input.collection}`;
  const path = input.instance ? `${base}/instances/${input.instance}/cube` : `${base}/cube`;
  return `${path}?${queryString({
    bbox: input.bbox,
    'parameter-name': input.parameters,
    crs: input.crs,
    datetime: `${formatUtc(input.start)}/${formatUtc(input.end)}`,
    f: 'CoverageJSON',
  })}`;
}
