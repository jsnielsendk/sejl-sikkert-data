import { describe, expect, it } from 'vitest';

import {
  currentCollection,
  DENMARK_BOUNDS,
  DKSS_IDW_COLLECTION,
  DKSS_NSBS_COLLECTION,
  TILE_COLS,
  TILE_ROWS,
  tilesFromConfig,
} from '../src/config';

const KM_PER_DEGREE_LAT = 111.32;

describe('tile coverage', () => {
  const tiles = tilesFromConfig();

  it('covers Danish waters with about 20 tiles of about 100 km', () => {
    expect(TILE_ROWS * TILE_COLS).toBe(20);
    expect(tiles).toHaveLength(20);
    expect(new Set(tiles.map((tile) => tile.id)).size).toBe(20);

    const width = DENMARK_BOUNDS.east - DENMARK_BOUNDS.west;
    const height = DENMARK_BOUNDS.north - DENMARK_BOUNDS.south;
    const tileArea = tiles.reduce(
      (sum, tile) => sum + (tile.bbox.east - tile.bbox.west) * (tile.bbox.north - tile.bbox.south),
      0,
    );
    expect(tileArea).toBeCloseTo(width * height, 8);

    expect(Math.min(...tiles.map((tile) => tile.bbox.west))).toBe(DENMARK_BOUNDS.west);
    expect(Math.min(...tiles.map((tile) => tile.bbox.south))).toBe(DENMARK_BOUNDS.south);
    expect(Math.max(...tiles.map((tile) => tile.bbox.east))).toBe(DENMARK_BOUNDS.east);
    expect(Math.max(...tiles.map((tile) => tile.bbox.north))).toBe(DENMARK_BOUNDS.north);

    for (let row = 0; row < TILE_ROWS; row += 1) {
      const line = tiles.filter((tile) => tile.id.startsWith(`r${row}`));
      expect(line).toHaveLength(TILE_COLS);
      for (let col = 0; col < line.length - 1; col += 1) {
        expect(line[col]?.bbox.east).toBeCloseTo(line[col + 1]?.bbox.west ?? 0, 8);
        expect(line[col]?.bbox.south).toBeCloseTo(line[col]?.bbox.south ?? 0, 8);
      }
      if (row < TILE_ROWS - 1) {
        const above = tiles.find((tile) => tile.id === `r${row + 1}c0`);
        expect(line[0]?.bbox.north).toBeCloseTo(above?.bbox.south ?? 0, 8);
      }
    }

    for (const tile of tiles) {
      const latitude = (tile.bbox.south + tile.bbox.north) / 2;
      const heightKm = (tile.bbox.north - tile.bbox.south) * KM_PER_DEGREE_LAT;
      const widthKm =
        (tile.bbox.east - tile.bbox.west) *
        KM_PER_DEGREE_LAT *
        Math.cos((latitude * Math.PI) / 180);
      expect(heightKm).toBeGreaterThan(90);
      expect(heightKm).toBeLessThan(110);
      expect(widthKm).toBeGreaterThan(90);
      expect(widthKm).toBeLessThan(110);
      expect(tile.bbox.west).toBeGreaterThanOrEqual(DENMARK_BOUNDS.west);
      expect(tile.bbox.east).toBeLessThanOrEqual(DENMARK_BOUNDS.east);
      expect(tile.bbox.south).toBeGreaterThanOrEqual(DENMARK_BOUNDS.south);
      expect(tile.bbox.north).toBeLessThanOrEqual(DENMARK_BOUNDS.north);
    }
  });

  it('uses the inner-waters current model only when the whole tile is inside it', () => {
    expect(currentCollection(tiles.find((tile) => tile.id === 'r0c0')!)).toBe(DKSS_NSBS_COLLECTION);
    expect(currentCollection(tiles.find((tile) => tile.id === 'r0c2')!)).toBe(DKSS_IDW_COLLECTION);
    const idw = tiles.filter((tile) => currentCollection(tile) === DKSS_IDW_COLLECTION);
    expect(idw.length).toBeGreaterThan(0);
    expect(idw.length).toBeLessThan(tiles.length);
  });
});
