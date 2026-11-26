import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface FixtureRepo {
  /** Canonical path of the repository root. */
  root: string;
  git(...args: string[]): Promise<string>;
  write(relativePath: string, content: string | Buffer): Promise<void>;
  remove(relativePath: string): Promise<void>;
  cleanup(): Promise<void>;
}

function fixtureEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: 'DevGuard Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'DevGuard Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    // Ignore the developer's own git configuration so fixtures behave the same everywhere.
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export interface FixtureOptions {
  /** Create the initial commit with a few sample files. Defaults to true. */
  commit?: boolean;
}

export async function createFixtureRepo(options: FixtureOptions = {}): Promise<FixtureRepo> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'devguard-repo-')));
  const env = fixtureEnv();

  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, { cwd: root, env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  };

  const write = async (relativePath: string, content: string | Buffer): Promise<void> => {
    const target = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };

  const remove = async (relativePath: string): Promise<void> => {
    await rm(path.join(root, ...relativePath.split('/')), { force: true });
  };

  await git('init', '-q', '-b', 'main');
  await git('config', 'core.autocrlf', 'false');
  await git('config', 'commit.gpgsign', 'false');

  if (options.commit !== false) {
    await write('src/a.ts', 'export const a = 1;\nexport const a2 = 2;\n');
    await write('src/b.ts', 'export const b = 1;\n');
    await write('README.md', '# Fixture\n\nSome documentation text for the fixture.\n');
    await write('docs/old name.md', 'Spaces in file names must survive parsing.\n');
    await write('assets/logo.bin', Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
    await git('add', '-A');
    await git('commit', '-q', '-m', 'init');
  }

  return {
    root,
    git,
    write,
    remove,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
