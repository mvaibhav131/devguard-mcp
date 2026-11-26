import { describe, expect, it } from 'vitest';

describe('toolchain smoke test', () => {
  it('runs on the supported Node.js version', () => {
    // With noUncheckedIndexedAccess, array items are `number | undefined`, hence the defaults.
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);

    expect(major > 22 || (major === 22 && minor >= 12)).toBe(true);
  });
});
