/**
 * Rounding belongs only in this write step. The forecast is still chosen at full precision.
 * Wind speed is a whole m/s. Current speed stays at 0.01 m/s.
 * Direction, for wind and current, is a whole degree inside [0, 360). 359.6 becomes 0, never 360.
 * Coordinates stay at 0.0001°. A wave cell, if one is ever written, uses whole degrees, 0.01 m and 0.1 s.
 * An empty cell stays {}. Numbers are emitted from toFixed text so JSON does not expand them.
 */

import type { ForecastSample, NeutralForecast } from './app/types';

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Tile ${label} is not finite (${String(value)}).`);
  }
  return value;
}

function trimZeros(text: string): string {
  if (!text.includes('.')) {
    return text === '-0' ? '0' : text;
  }
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

function emitRounded(value: number, decimals: number, label: string): string {
  return trimZeros(requireFinite(value, label).toFixed(decimals));
}

/** Whole degrees, then back into [0, 360). 359.6 becomes 0, never 360. */
export function roundDirectionText(degrees: number): string {
  const text = requireFinite(degrees, 'direction').toFixed(0);
  if (text === '360' || text === '-0' || text === '-360') {
    return '0';
  }
  const turns = ((Number(text) % 360) + 360) % 360;
  return turns === 0 ? '0' : String(turns);
}

function emitSample(sample: ForecastSample): string {
  const parts: string[] = [];
  if (sample.wind) {
    parts.push(
      `"wind":{"directionDegrees":${roundDirectionText(sample.wind.directionDegrees)},"speed":${emitRounded(sample.wind.speed, 0, 'wind speed')},"unit":${JSON.stringify(sample.wind.unit)}}`,
    );
  }
  if (sample.current) {
    parts.push(
      `"current":{"directionDegrees":${roundDirectionText(sample.current.directionDegrees)},"speed":${emitRounded(sample.current.speed, 2, 'current speed')},"unit":${JSON.stringify(sample.current.unit)}}`,
    );
  }
  if (sample.wave) {
    parts.push(
      `"wave":{"directionDegrees":${roundDirectionText(sample.wave.directionDegrees)},"heightMeters":${emitRounded(sample.wave.heightMeters, 2, 'wave height')},"periodSeconds":${emitRounded(sample.wave.periodSeconds, 1, 'wave period')}}`,
    );
  }
  return `{${parts.join(',')}}`;
}

function emitSamples(samples: readonly (readonly (readonly ForecastSample[])[])[]): string {
  return `[${samples
    .map((step) => `[${step.map((row) => `[${row.map((cell) => emitSample(cell)).join(',')}]`).join(',')}]`)
    .join(',')}]`;
}

function emitAxis(values: readonly number[]): string {
  return `[${values.map((value) => emitRounded(value, 4, 'coordinate')).join(',')}]`;
}

export function serializeTile(forecast: NeutralForecast): string {
  const head = [
    `"regionId":${JSON.stringify(forecast.regionId)}`,
    `"providerId":${JSON.stringify(forecast.providerId)}`,
    `"model":${JSON.stringify(forecast.model)}`,
    `"modelRunAt":${JSON.stringify(forecast.modelRunAt)}`,
    `"fetchedAt":${JSON.stringify(forecast.fetchedAt)}`,
    `"expiresAt":${JSON.stringify(forecast.expiresAt)}`,
    `"license":${JSON.stringify(forecast.license)}`,
    `"licenseUrl":${JSON.stringify(forecast.licenseUrl)}`,
    `"attribution":${JSON.stringify(forecast.attribution)}`,
    `"timeAxis":${JSON.stringify(forecast.timeAxis)}`,
  ];
  const geometry =
    forecast.geometry.kind === 'points'
      ? `"geometry":{"kind":"points","points":[${forecast.geometry.points
          .map(
            (point) =>
              `{"latitude":${emitRounded(point.latitude, 4, 'coordinate')},"longitude":${emitRounded(point.longitude, 4, 'coordinate')},"samples":[${point.samples
                .map((sample) => emitSample(sample))
                .join(',')}]}`,
          )
          .join(',')}]}`
      : `"geometry":{"kind":"grid","latitudes":${emitAxis(forecast.geometry.latitudes)},"longitudes":${emitAxis(forecast.geometry.longitudes)},"samples":${emitSamples(forecast.geometry.samples)}}`;
  return `{${head.join(',')},${geometry}}`;
}
