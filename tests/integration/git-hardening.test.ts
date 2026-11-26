import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitClient } from '../../src/infrastructure/git/git-client.js';
import { GitRunner } from '../../src/infrastructure/git/git-runner.js';
import { DEFAULT_LIMITS } from '../../src/shared/limits.js';
import { createFixtureRepo, type FixtureRepo } from '../fixtures/fixture-repo.js';

describe('git hardening against repository-defined commands', () => {
  let repo: FixtureRepo;
  let client: GitClient;
  let marker: string;
  let script: string;
  let command: string;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    client = new GitClient(new GitRunner({ cwd: repo.root, limits: DEFAULT_LIMITS }), repo.root);

    // The marker and script live next to the repository, outside of it, so they never show up in a diff.
    marker = `${repo.root}.marker`;
    script = `${repo.root}.evil.cjs`;
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
    command = `node "${script.replaceAll('\\', '/')}"`;

    await repo.write('src/a.ts', 'export const a = 42;\n');
  });

  afterEach(async () => {
    await Promise.all([repo.cleanup(), rm(marker, { force: true }), rm(script, { force: true })]);
  });

  // Plain git runs the configured command. This proves the setup is effective, so that
  // "marker does not exist" after DevGuard's call means something.
  async function expectPlainGitToExecuteIt(): Promise<void> {
    await repo.git('diff', 'HEAD');
    expect(existsSync(marker)).toBe(true);
    await rm(marker);
  }

  const devGuardPatch = () =>
    client.readDiff({ spec: { kind: 'workingTree', hasHead: true }, format: 'patch', pathspecs: [], maxBytes: 100_000 });

  it('does not run diff.external', async () => {
    await repo.git('config', 'diff.external', command);
    await expectPlainGitToExecuteIt();

    await devGuardPatch();

    expect(existsSync(marker)).toBe(false);
  });

  it('does not run a textconv command', async () => {
    await repo.write('.gitattributes', '*.ts diff=evil\n');
    await repo.git('config', 'diff.evil.textconv', command);
    await expectPlainGitToExecuteIt();

    await devGuardPatch();

    expect(existsSync(marker)).toBe(false);
  });

  it('does not run core.fsmonitor', async () => {
    await repo.git('config', 'core.fsmonitor', command);
    await expectPlainGitToExecuteIt();

    await devGuardPatch();

    expect(existsSync(marker)).toBe(false);
  });
});
