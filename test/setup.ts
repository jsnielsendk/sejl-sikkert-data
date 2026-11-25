import { beforeAll, vi } from 'vitest';

beforeAll(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('tests must not use the network')));
});
