import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { APP_COMMIT } from '../src/config';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app');

const APP_FILES = [
  'client.ts',
  'convert.ts',
  'coverage.ts',
  'lambert.ts',
  'types.ts',
  'validate.ts',
  'vectorGrid.ts',
] as const;

type Checksums = {
  appRepo: string;
  appCommit: string;
  files: Record<string, string>;
  excerpts: Record<string, string>;
};

describe('copied app conversion', () => {
  it('pins the app originals and the local excerpts', () => {
    const manifest = JSON.parse(readFileSync(path.join(appDir, 'checksums.json'), 'utf8')) as Checksums;
    expect(manifest.appRepo).toBe('jsnielsendk/sejl-sikkert-app');
    expect(manifest.appCommit).toBe(APP_COMMIT);
    expect(Object.keys(manifest.files).sort()).toEqual([...APP_FILES].sort());
    const present = readdirSync(appDir)
      .filter((name) => name.endsWith('.ts'))
      .sort();
    expect(Object.keys(manifest.excerpts).sort()).toEqual(present);
    for (const name of present) {
      expect(manifest.files[name]).toMatch(/^[0-9a-f]{64}$/);
      const hash = createHash('sha256').update(readFileSync(path.join(appDir, name))).digest('hex');
      expect(manifest.excerpts[name], name).toBe(hash);
      expect(manifest.files[name], name).not.toBe(hash);
    }
  });
});
