import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Tile } from './config';
import type { DmiHttp } from './dmi/serial';
import { buildDataset } from './pipeline';

function outDirFrom(argv: readonly string[]): string {
  const index = argv.indexOf('--out');
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : 'out';
}

export async function main(
  argv: readonly string[],
  deps?: {
    now?: Date;
    tiles?: readonly Tile[];
    http?: DmiHttp;
    sleep?: (ms: number) => Promise<void>;
    pauseMs?: number;
  },
): Promise<number> {
  const outDir = outDirFrom(argv);
  try {
    const report = await buildDataset({ outDir, ...deps });
    const kib = report.bytes / 1024;
    console.log(
      JSON.stringify({
        outDir: report.outDir,
        calls: report.calls,
        durationMs: report.durationMs,
        bytes: report.bytes,
        kib: Math.round(kib * 10) / 10,
        saw429: report.saw429,
      }),
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`build-data failed: ${message}`);
    return 1;
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  });
}
