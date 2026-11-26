import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { SERVER_VERSION } from '../../src/shared/version.js';

it('keeps the version constant in sync with package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

  expect(SERVER_VERSION).toBe(pkg.version);
});
