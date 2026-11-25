/**
 * Copied from jsnielsendk/sejl-sikkert-app@aa67b261981f151cc7869945ec0bcfb0f8917719
 * Source: src/features/weather/dmi/lambert.ts
 *
 * HARMONIE DINI Lambert conformal conic.
 * False origin 55.5°N, 8°W. Sphere radius 6_371_229 m. Both standard parallels are 55.5°.
 * EDR CoverageJSON for crs=native reports these axes in kilometres, not metres.
 */

const EARTH_RADIUS_M = 6_371_229;
const PHI0 = (55.5 * Math.PI) / 180;
const LAM0 = (-8 * Math.PI) / 180;
const CONE = Math.sin(PHI0);
const F = (Math.cos(PHI0) * Math.tan(Math.PI / 4 + PHI0 / 2) ** CONE) / CONE;
const RHO0 = (EARTH_RADIUS_M * F) / Math.tan(Math.PI / 4 + PHI0 / 2) ** CONE;

export function lambertForward(
  longitude: number,
  latitude: number,
): { easting: number; northing: number } {
  const phi = (latitude * Math.PI) / 180;
  const lam = (longitude * Math.PI) / 180;
  const rho = (EARTH_RADIUS_M * F) / Math.tan(Math.PI / 4 + phi / 2) ** CONE;
  const theta = CONE * (lam - LAM0);
  return {
    easting: rho * Math.sin(theta),
    northing: RHO0 - rho * Math.cos(theta),
  };
}

export function lambertInverse(
  easting: number,
  northing: number,
): { longitude: number; latitude: number } {
  const theta = Math.atan2(easting, RHO0 - northing);
  const rho = Math.sign(CONE) * Math.hypot(easting, RHO0 - northing);
  const phi = 2 * Math.atan(((EARTH_RADIUS_M * F) / rho) ** (1 / CONE)) - Math.PI / 2;
  const lam = theta / CONE + LAM0;
  return { longitude: (lam * 180) / Math.PI, latitude: (phi * 180) / Math.PI };
}

export function nativeBboxKm(bounds: {
  west: number;
  south: number;
  east: number;
  north: number;
}): string {
  const corners = [
    lambertForward(bounds.west, bounds.south),
    lambertForward(bounds.east, bounds.south),
    lambertForward(bounds.west, bounds.north),
    lambertForward(bounds.east, bounds.north),
  ];
  const eastings = corners.map((corner) => corner.easting / 1000);
  const northings = corners.map((corner) => corner.northing / 1000);
  const pad = 2;
  const minE = Math.min(...eastings) - pad;
  const maxE = Math.max(...eastings) + pad;
  const minN = Math.min(...northings) - pad;
  const maxN = Math.max(...northings) + pad;
  const fmt = (value: number) => value.toFixed(3);
  return `${fmt(minE)},${fmt(minN)},${fmt(maxE)},${fmt(maxN)}`;
}

/** Grid-relative HARMONIE u/v to true-north components. No-op on the central meridian. */
export function rotateGridVectorToTrue(
  u: number,
  v: number,
  longitude: number,
  out?: { u: number; v: number },
): { u: number; v: number } {
  const delta = normalizeDegrees(longitude + 8 + 180) - 180;
  const ang = ((delta * Math.PI) / 180) * CONE;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const target = out ?? { u: 0, v: 0 };
  target.u = cos * u + sin * v;
  target.v = -sin * u + cos * v;
  return target;
}

export function normalizeDegrees(value: number): number {
  const turns = value % 360;
  return turns < 0 ? turns + 360 : turns;
}
