import path from 'node:path';

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIRECTORY = /(?:^|\/)__tests__\//;

export function isTestFile(filePath: string): boolean {
  return TEST_FILE.test(filePath) || TEST_DIRECTORY.test(filePath);
}

/** "src/a.test.ts" and "src/a.ts" both have the stem "a". */
export function fileStem(filePath: string): string {
  const name = path.posix.basename(filePath);
  return name.replace(TEST_FILE, '').replace(/\.[^.]+$/, '');
}
