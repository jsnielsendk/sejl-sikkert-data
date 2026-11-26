/**
 * Rounding belongs only in this write step. The forecast is still chosen at full precision.
 * Speed is stored to 0.01 m/s, direction to 0.1° inside [0, 360), and coordinates to 0.0001°.
 * A wave cell, if one is ever written, uses 0.01 m and 0.1 s. An empty cell stays {}.
 * Numbers are emitted from toFixed text so a value such as 200.2 is not expanded by JSON.stringify.
 */

import type { ForecastSample, NeutralForecast } from './app/types';

function trimZeros(text: string): string {
  if (!text.includes('.')) {
    return text === '-0' ? '0' : text;
  }
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

function emitRounded(value: number, decimals: number): string {
  return trimZeros(value.toFixed(decimals));
}

/** One decimal, then back into [0, 360). 359.96 becomes 0, never 360. */
export function roundDirectionText(degrees: number): string {
  const text = degrees.toFixed(1);
  if (text === '360.0' || text === '-0.0' || text === '-360.0') {
    return '0';
  }
  const numeric = Number(text);
  const turns = ((numeric % 360) + 360) % 360;
  if (turns === 0) {
    return '0';
  }
  return trimZeros(turns.toFixed(1));
}

function emitSample(sample: ForecastSample): string {
  const parts: string[] = [];
  if (sample.wind) {
    parts.push(
      `"wind":{"directionDegrees":${roundDirectionText(sample.wind.directionDegrees)},"speed":${emitRounded(sample.wind.speed, 2)},"unit":${JSON.stringify(sample.wind.unit)}}`,
    );
  }
  if (sample.current) {
    parts.push(
      `"current":{"directionDegrees":${roundDirectionText(sample.current.directionDegrees)},"speed":${emitRounded(sample.current.speed, 2)},"unit":${JSON.stringify(sample.current.unit)}}`,
    );
  }
  if (sample.wave) {
    parts.push(
      `"wave":{"directionDegrees":${roundDirectionText(sample.wave.directionDegrees)},"heightMeters":${emitRounded(sample.wave.heightMeters, 2)},"periodSeconds":${emitRounded(sample.wave.periodSeconds, 1)}}`,
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
  return `[${values.map((value) => emitRounded(value, 4)).join(',')}]`;
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
              `{"latitude":${emitRounded(point.latitude, 4)},"longitude":${emitRounded(point.longitude, 4)},"samples":[${point.samples
                .map((sample) => emitSample(sample))
                .join(',')}]}`,
          )
          .join(',')}]}`
      : `"geometry":{"kind":"grid","latitudes":${emitAxis(forecast.geometry.latitudes)},"longitudes":${emitAxis(forecast.geometry.longitudes)},"samples":${emitSamples(forecast.geometry.samples)}}`;
  return `{${head.join(',')},${geometry}}`;
}
