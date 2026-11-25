/**
 * Copied from jsnielsendk/sejl-sikkert-app@aa67b261981f151cc7869945ec0bcfb0f8917719
 * Source: src/weather/validate.ts
 */

import type { ForecastSample, NeutralForecast } from './types';

function assertSample(sample: ForecastSample): void {
  if (sample.wind && sample.wind.unit !== 'm/s' && sample.wind.unit !== 'kn') {
    throw new Error('Wind vector is missing a speed unit.');
  }
  if (sample.current && sample.current.unit !== 'm/s' && sample.current.unit !== 'kn') {
    throw new Error('Current vector is missing a speed unit.');
  }
}

export function assertNeutralForecast(forecast: NeutralForecast): void {
  if (forecast.providerId.trim() === '' || forecast.timeAxis.length === 0) {
    throw new Error('A forecast needs a provider id and a time axis.');
  }
  if (forecast.geometry.kind === 'points') {
    for (const point of forecast.geometry.points) {
      if (point.samples.length !== forecast.timeAxis.length) {
        throw new Error('Point samples must follow the time axis.');
      }
      point.samples.forEach(assertSample);
    }
    return;
  }
  const { latitudes, longitudes, samples } = forecast.geometry;
  if (samples.length !== forecast.timeAxis.length) {
    throw new Error('Grid time steps must follow the time axis.');
  }
  for (const timeStep of samples) {
    if (timeStep.length !== latitudes.length) {
      throw new Error('Grid latitude rows do not match the latitude axis.');
    }
    for (const row of timeStep) {
      if (row.length !== longitudes.length) {
        throw new Error('Grid longitude columns do not match the longitude axis.');
      }
      row.forEach(assertSample);
    }
  }
}
