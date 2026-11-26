/**
 * Grid and bounding box for the Danish waters tiles.
 * The outer box is the Denmark region from sejl-sikkert-app
 * src/regions/regions.ts at aa67b261981f151cc7869945ec0bcfb0f8917719.
 * Four rows by five columns give 20 tiles of about 100 km.
 */

/** App commit whose original sources are hashed in src/app/checksums.json. */
export const APP_COMMIT = '7dd41ec73ad5ed2e3b4738800a245dd2e37c890d';

export const DENMARK_BOUNDS = {
  west: 7.5,
  south: 54.4,
  east: 15.5,
  north: 58.2,
} as const;

export const TILE_ROWS = 4;
export const TILE_COLS = 5;

/** Published dkss_idw extent (crs84). Tiles fully inside it use that model. */
export const DKSS_IDW_EXTENT = {
  west: 9.34,
  south: 53.587,
  east: 14.826,
  north: 57.596,
} as const;

export const HARMONIE_COLLECTION = 'harmonie_dini_sf';
export const DKSS_IDW_COLLECTION = 'dkss_idw';
export const DKSS_NSBS_COLLECTION = 'dkss_nsbs';

export const FORMAT_VERSION = '1';

export const DATA_ATTRIBUTION = 'Kilde: DMI (Danmarks Meteorologiske Institut), bearbejdet';
export const DATA_LICENSE = 'CC BY 4.0';
export const DATA_LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/';

/**
 * Pause between DMI requests. Retries use a separate backoff.
 * Raise `DMI_PAUSE_MS` when 429s are frequent. Do not raise the attempt cap.
 */
export const REQUEST_PAUSE_MS = 2000;

export const PAUSE_ENV = 'DMI_PAUSE_MS';

/** One try plus retries. A 429 or 5xx is not attempted more than this. */
export const MAX_ATTEMPTS = 3;

/**
 * Backoff after a 429 or 5xx. A short limit at DMI outlasts 1–2 seconds,
 * so the two waits are long enough that the third attempt can succeed.
 * A Retry-After header, when present and longer, replaces the wait, but never past the cap.
 */
export const RETRY_DELAYS_MS = [20_000, 40_000] as const;

/** Upper bound for a single retry wait, including a large Retry-After. */
export const MAX_RETRY_AFTER_MS = 120_000;

export function pauseMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PAUSE_ENV];
  if (raw === undefined || raw.trim() === '') {
    return REQUEST_PAUSE_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${PAUSE_ENV} must be a non-negative number of milliseconds.`);
  }
  return value;
}

export type Bbox = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type Tile = {
  id: string;
  bbox: Bbox;
};

export function tilesFromConfig(
  bounds: Bbox = DENMARK_BOUNDS,
  rows = TILE_ROWS,
  cols = TILE_COLS,
): Tile[] {
  const height = (bounds.north - bounds.south) / rows;
  const width = (bounds.east - bounds.west) / cols;
  const tiles: Tile[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const south = bounds.south + row * height;
      const west = bounds.west + col * width;
      tiles.push({
        id: `r${row}c${col}`,
        bbox: {
          west,
          south,
          east: col === cols - 1 ? bounds.east : bounds.west + (col + 1) * width,
          north: row === rows - 1 ? bounds.north : bounds.south + (row + 1) * height,
        },
      });
    }
  }
  return tiles;
}

export function currentCollection(tile: Tile): typeof DKSS_IDW_COLLECTION | typeof DKSS_NSBS_COLLECTION {
  const box = tile.bbox;
  const inside =
    box.west >= DKSS_IDW_EXTENT.west &&
    box.east <= DKSS_IDW_EXTENT.east &&
    box.south >= DKSS_IDW_EXTENT.south &&
    box.north <= DKSS_IDW_EXTENT.north;
  return inside ? DKSS_IDW_COLLECTION : DKSS_NSBS_COLLECTION;
}
