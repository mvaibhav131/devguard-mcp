import { describe, expect, it } from 'vitest';

import { applyLineRules, contextFor, isGeneratedPath, LINE_RULES } from '../../src/core/review/rules.js';

// Secret-looking values are assembled at run time so that this file does not contain real-looking secrets.
const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const githubToken = ['ghp', '_', 'a'.repeat(36)].join('');
const slackToken = ['xox', 'b-1234567890-abcdefghij'].join('');
const privateKeyHeader = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('');

const rulesFor = (file: string, text: string): string[] =>
  applyLineRules(contextFor(file), [{ line: 1, text }], LINE_RULES, 20).findings.map((finding) => finding.rule);

describe('review rules: positives and negatives', () => {
  it.each([
    ['secret-private-key', 'src/k.ts', privateKeyHeader, '-----BEGIN PUBLIC KEY-----'],
    ['secret-aws-access-key', 'src/k.ts', `const key = '${awsKey}';`, "const key = 'AKIA1234';"],
    ['secret-github-token', 'src/k.ts', `const t = '${githubToken}';`, "const t = 'ghp_short';"],
    ['secret-slack-token', 'src/k.ts', `const t = '${slackToken}';`, "const t = 'xoxb';"],
    ['secret-generic-assignment', 'src/k.ts', 'const password = "s3cr3t-value-123";', 'const password = process.env.PASSWORD;'],
    ['secret-generic-assignment', 'config/app.yaml', "apiKey: 'abcdef123456'", "token: 'your-token-here'"],
    ['dangerous-eval', 'src/a.ts', 'const r = eval(code);', 'const r = evaluate(code);'],
    ['dangerous-eval', 'src/a.ts', "const f = new Function('a', 'return a');", 'const r = obj.eval(code);'],
    ['dangerous-html', 'src/a.ts', 'el.innerHTML = html;', 'el.textContent = text;'],
    ['dangerous-html', 'src/a.tsx', '<div dangerouslySetInnerHTML={{ __html: x }} />', '<div>{x}</div>'],
    ['command-injection-risk', 'src/a.ts', 'execSync(`ls ${dir}`);', "execFileSync('ls', [dir]);"],
    ['command-injection-risk', 'src/a.ts', "exec('git ' + arg);", "execFile('git', [arg]);"],
    ['command-injection-risk', 'src/a.ts', 'spawn(cmd, args, { shell: true });', 'spawn(cmd, args);'],
    ['weak-hash', 'src/a.ts', "createHash('md5').update(x)", "createHash('sha256').update(x)"],
    ['insecure-random', 'src/a.ts', 'const token = Math.random().toString(36);', 'const jitter = Math.random();'],
    ['tls-verification-disabled', 'src/a.ts', '{ rejectUnauthorized: false }', '{ rejectUnauthorized: true }'],
    ['tls-verification-disabled', 'src/a.ts', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';", "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';"],
    ['plain-http-url', 'src/a.ts', "fetch('http://example.com/api');", "fetch('http://localhost:3000/api');"],
    ['ts-suppression', 'src/a.ts', '// @ts-ignore', '// @ts-expect-error reason'],
    ['ts-suppression', 'src/a.ts', '/* @ts-nocheck */', 'const x = 1;'],
    ['eslint-disable', 'src/a.ts', '// eslint-disable-next-line no-console', '// eslint is great'],
    ['any-type', 'src/a.ts', 'let x: any = 1;', 'let x: unknown = 1;'],
    ['any-type', 'src/a.ts', 'const y = value as any;', 'const company = 1;'],
    ['empty-catch', 'src/a.ts', 'try { run(); } catch (error) {}', 'try { run(); } catch (error) { log(error); }'],
    ['empty-catch', 'src/a.ts', 'try { run(); } catch {}', 'try { run(); } catch { log(); }'],
    ['debugger-statement', 'src/a.ts', '  debugger;', '// debugger'],
    ['console-output', 'src/a.ts', "console.log('x');", "console.error('x');"],
    ['focused-test', 'tests/a.test.ts', "it.only('x', () => {});", "it('x', () => {});"],
    ['focused-test', 'tests/a.test.ts', "fdescribe('x', () => {});", "describe('x', () => {});"],
    ['skipped-test', 'tests/a.test.ts', "it.skip('x', () => {});", "it('x', () => {});"],
    ['skipped-test', 'tests/a.test.ts', "xdescribe('x', () => {});", "describe('x', () => {});"],
    ['todo-marker', 'src/a.ts', '// TODO: handle errors', 'const todos = [];'],
    ['todo-marker', 'README.md', 'FIXME later', 'The TODOS list'],
  ])('%s fires on %s: %j and stays quiet on %j', (rule, file, positive, negative) => {
    expect(rulesFor(file, positive)).toContain(rule);
    expect(rulesFor(file, negative)).not.toContain(rule);
  });
});

describe('review rules: masking, scope and caps', () => {
  it('never echoes a secret in the evidence', () => {
    const lines = [
      `const key = '${awsKey}';`,
      `const t = '${githubToken}';`,
      `const s = '${slackToken}';`,
      privateKeyHeader,
      'const password = "s3cr3t-value-123";',
    ];

    const findings = applyLineRules(contextFor('src/k.ts'), lines.map((text, index) => ({ line: index + 1, text })), LINE_RULES, 20).findings;

    expect(findings.map((finding) => finding.rule)).toEqual([
      'secret-aws-access-key',
      'secret-github-token',
      'secret-slack-token',
      'secret-private-key',
      'secret-generic-assignment',
    ]);
    for (const finding of findings) {
      expect(finding.evidence).toContain('[REDACTED]');
      for (const value of [awsKey, githubToken, slackToken, 'PRIVATE KEY', 's3cr3t-value-123']) expect(finding.evidence).not.toContain(value);
    }
  });

  it('applies rules by file type: code rules not to markdown or tests, test rules only to tests', () => {
    expect(rulesFor('README.md', 'eval(x) and console.log(1)')).toEqual([]);
    expect(rulesFor('tests/a.test.ts', "console.log('x'); el.innerHTML = x; let y: any;")).toEqual([]);
    expect(rulesFor('src/a.ts', "it.only('x', () => {});")).toEqual([]);
    expect(rulesFor('src/a.js', 'let x: any = 1;')).toEqual([]);
  });

  it('skips comment lines for code rules but not for markers that live in comments', () => {
    expect(rulesFor('src/a.ts', '// eval(x)')).toEqual([]);
    expect(rulesFor('src/a.ts', ' * console.log(x)')).toEqual([]);
    expect(rulesFor('src/a.ts', '// TODO fix')).toEqual(['todo-marker']);
  });

  it('ignores generated files, lock files and third-party folders', () => {
    for (const file of ['package-lock.json', 'pnpm-lock.yaml', 'dist/index.js', 'src/vendor.min.js', 'node_modules/x/index.js', 'coverage/lcov.info', 'a.js.map']) {
      expect(isGeneratedPath(file)).toBe(true);
      expect(rulesFor(file, `const password = "s3cr3t-value-123"; // TODO eval(x)`)).toEqual([]);
    }
    expect(isGeneratedPath('src/a.ts')).toBe(false);
  });

  it('caps findings per rule and file and reports how many were left out', () => {
    const lines = Array.from({ length: 30 }, (_, index) => ({ line: index + 1, text: '// TODO later' }));

    const result = applyLineRules(contextFor('src/a.ts'), lines, LINE_RULES, 20);

    expect(result.findings).toHaveLength(20);
    expect(result.omitted).toBe(10);
  });

  it('has unique rule ids with a description and a suggestion each', () => {
    const ids = LINE_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of LINE_RULES) {
      expect(rule.description.length).toBeGreaterThan(10);
      expect(rule.suggestion.length).toBeGreaterThan(10);
    }
  });
});
