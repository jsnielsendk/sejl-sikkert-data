/**
 * Copied from jsnielsendk/sejl-sikkert-app@7dd41ec73ad5ed2e3b4738800a245dd2e37c890d
 * Source: src/weather/types.ts
 */

export type SpeedUnit = 'm/s' | 'kn';

/** Meteorological wind: direction is where the wind comes FROM, degrees true. */
export type WindVector = {
  directionDegrees: number;
  speed: number;
  unit: SpeedUnit;
};

/** Oceanographic current: direction is where the current goes TOWARD, degrees true. */
export type CurrentVector = {
  directionDegrees: number;
  speed: number;
  unit: SpeedUnit;
};

/** Wave direction is where the waves come FROM, degrees true. */
export type WaveVector = {
  directionDegrees: number;
  heightMeters: number;
  periodSeconds: number;
};

export type ForecastSample = {
  wind?: WindVector;
  current?: CurrentVector;
  wave?: WaveVector;
};

export type ForecastPoint = {
  latitude: number;
  longitude: number;
  /** Aligned with NeutralForecast.timeAxis. */
  samples: readonly ForecastSample[];
};

/**
 * Provider-neutral forecast. Screens and the map read this shape only.
 * A grid is indexed samples[time][latitude][longitude].
 */
export type NeutralForecast = {
  regionId: string;
  providerId: string;
  model: string;
  modelRunAt: string;
  fetchedAt: string;
  expiresAt: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  timeAxis: readonly string[];
  geometry:
    | {
        kind: 'points';
        points: readonly ForecastPoint[];
      }
    | {
        kind: 'grid';
        latitudes: readonly number[];
        longitudes: readonly number[];
        samples: readonly (readonly (readonly ForecastSample[])[])[];
      };
};
