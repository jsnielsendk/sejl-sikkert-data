import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function workflow(name: string): string {
  return readFileSync(path.join(root, '.github', 'workflows', name), 'utf8');
}

describe('GitHub workflows', () => {
  it('builds and deploys Pages on the 3-hour schedule without cancelling a run', () => {
    const text = workflow('build-deploy.yml');
    expect(text).toContain("cron: '47 */3 * * *'");
    expect(text).toContain("cron: '17 1-23/3 * * *'");
    expect(text).toContain('scripts/buildDecision.ts');
    expect(text).toContain('trigger/build.txt');
    expect(text).toContain('ref: main');
    expect(text).toContain("github.event.inputs.force != 'true'");
    expect(text).toContain('force:');
    expect(readFileSync(path.join(root, 'scripts', 'buildDecision.ts'), 'utf8')).toContain(
      'GITHUB_RUN_ID',
    );
    expect(text).toContain("steps.freshness.outputs.skip != 'true'");
    expect(text).toContain("needs.build.result == 'success' && needs.build.outputs.skip != 'true'");
    expect(text).not.toContain('continue-on-error');
    expect(text).toContain('workflow_dispatch:');
    expect(text).toMatch(/permissions:[\s\S]*contents: read/);
    expect(text).toContain('pages: write');
    expect(text).toContain('id-token: write');
    expect(text).toContain('group: pages-data');
    expect(text).toContain('cancel-in-progress: false');
    expect(text).toContain('timeout-minutes: 30');
    expect(text).toContain('timeout-minutes: 10');
    expect(text).toContain('npm run build-data');
    expect(text).toContain("DMI_PAUSE_MS: '2000'");
    expect(text).toContain('actions/upload-pages-artifact@v5');
    expect(text).toContain('include-hidden-files: true');
    expect(text).toContain('actions/deploy-pages@v5');
    expect(text).toContain('name: github-pages');
    expect(text).toContain('needs: build');
    expect(text).not.toContain('contents: write');
  });

  it('keeps contents write on the monthly keepalive job only', () => {
    const text = workflow('keepalive.yml');
    expect(text).toContain("cron: '17 6 1 * *'");
    expect(text).toContain('contents: read');
    expect(text).toContain('contents: write');
    expect(text).toContain('keepalive.txt');
    expect(text).toContain('timeout-minutes: 10');
    const writeAt = text.indexOf('contents: write');
    const jobAt = text.indexOf('commit:');
    expect(writeAt).toBeGreaterThan(jobAt);
    expect(text.slice(0, jobAt)).not.toContain('contents: write');
  });
});
