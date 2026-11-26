export type ImportKind = 'import' | 'export-from' | 'dynamic-import' | 'require' | 'side-effect';

export interface ImportRef {
  specifier: string;
  kind: ImportKind;
  /** `import type ...` and `export type ... from`. They still couple files, so they are kept. */
  typeOnly: boolean;
}

export interface ExtractResult {
  imports: ImportRef[];
  /** import() and require() calls whose argument is not a plain string. These cannot be followed. */
  nonLiteralDynamic: number;
}

type Token =
  | { type: 'word' | 'punct' | 'regex' | 'template'; value: string }
  | { type: 'string'; value: string };

const REGEX_PREFIX_WORDS: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'void',
  'delete',
  'new',
  'throw',
  'yield',
  'await',
  'instanceof',
]);

const MAX_CLAUSE_TOKENS = 500;

function isWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 || // _
    code === 36 || // $
    code > 127
  );
}

/** Returns the index after the closing quote, or the index of the newline for an unterminated string. */
function skipString(source: string, start: number): number {
  const quote = source.charAt(start);
  let i = start + 1;
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === '\n') return i;
    i++;
  }
  return source.length;
}

function skipTemplate(source: string, start: number): { end: number; hasExpression: boolean } {
  let i = start + 1;
  let hasExpression = false;
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === '\\') {
      i += 2;
    } else if (c === '`') {
      return { end: i + 1, hasExpression };
    } else if (c === '$' && source.charAt(i + 1) === '{') {
      hasExpression = true;
      i = skipExpression(source, i + 2);
    } else {
      i++;
    }
  }
  return { end: source.length, hasExpression };
}

function skipExpression(source: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    const c = source.charAt(i);
    if (c === '{') {
      depth++;
      i++;
    } else if (c === '}') {
      depth--;
      i++;
    } else if (c === '`') {
      i = skipTemplate(source, i).end;
    } else if (c === '"' || c === "'") {
      i = skipString(source, i);
    } else {
      i++;
    }
  }
  return i;
}

/** Returns the index after the regex literal, or -1 when the slash is not a regex. */
function skipRegex(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '\n') return -1;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i + 1;
    i++;
  }
  return -1;
}

/** Splits source into the few token kinds that matter, skipping comments and the inside of strings, templates and regexes. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const regexAllowed = (): boolean => {
    const previous = tokens[tokens.length - 1];
    if (!previous) return true;
    if (previous.type === 'string' || previous.type === 'template' || previous.type === 'regex') return false;
    if (previous.type === 'word') return REGEX_PREFIX_WORDS.has(previous.value);
    return previous.value !== ')' && previous.value !== ']' && previous.value !== '}';
  };

  while (i < source.length) {
    const c = source.charAt(i);
    const code = source.charCodeAt(i);

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (c === '/' && source.charAt(i + 1) === '/') {
      while (i < source.length && source.charAt(i) !== '\n') i++;
    } else if (c === '/' && source.charAt(i + 1) === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '/' && regexAllowed()) {
      const end = skipRegex(source, i);
      if (end === -1) {
        tokens.push({ type: 'punct', value: '/' });
        i++;
      } else {
        tokens.push({ type: 'regex', value: '' });
        i = end;
      }
    } else if (c === '"' || c === "'") {
      const end = skipString(source, i);
      const closed = end > i + 1 && source.charAt(end - 1) === c;
      tokens.push({ type: 'string', value: source.slice(i + 1, closed ? end - 1 : end) });
      i = end;
    } else if (c === '`') {
      const { end, hasExpression } = skipTemplate(source, i);
      if (hasExpression) tokens.push({ type: 'template', value: '' });
      else tokens.push({ type: 'string', value: source.slice(i + 1, Math.max(i + 1, end - 1)) });
      i = end;
    } else if (isWordCode(code)) {
      let end = i + 1;
      while (end < source.length && isWordCode(source.charCodeAt(end))) end++;
      tokens.push({ type: 'word', value: source.slice(i, end) });
      i = end;
    } else {
      tokens.push({ type: 'punct', value: c });
      i++;
    }
  }
  return tokens;
}

/**
 * Heuristic extraction of module specifiers: static import and export-from statements,
 * import() and require() with a string literal. Not a parser, see docs for the known limits.
 */
export function extractImports(source: string): ExtractResult {
  const tokens = tokenize(source.replace(/^\uFEFF/, ''));
  const imports: ImportRef[] = [];
  const seen = new Set<string>();
  let nonLiteralDynamic = 0;

  const at = (index: number): Token | undefined => tokens[index];
  const isWord = (token: Token | undefined, value: string): boolean => token?.type === 'word' && token.value === value;
  const isPunct = (token: Token | undefined, value: string): boolean => token?.type === 'punct' && token.value === value;
  const stringAt = (index: number): string | undefined => {
    const token = at(index);
    return token?.type === 'string' ? token.value : undefined;
  };
  const add = (specifier: string, kind: ImportKind, typeOnly: boolean): void => {
    const key = `${kind}|${typeOnly}|${specifier}`;
    if (seen.has(key)) return;
    seen.add(key);
    imports.push({ specifier, kind, typeOnly });
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token?.type !== 'word') continue;
    if (isPunct(at(i - 1), '.')) continue; // obj.import, obj.require

    if (token.value === 'import') {
      const next = at(i + 1);

      if (isPunct(next, '(')) {
        const specifier = stringAt(i + 2);
        if (specifier !== undefined && (isPunct(at(i + 3), ')') || isPunct(at(i + 3), ','))) add(specifier, 'dynamic-import', false);
        else nonLiteralDynamic++;
        continue;
      }
      if (isPunct(next, '.')) continue; // import.meta

      const sideEffect = stringAt(i + 1);
      if (sideEffect !== undefined) {
        add(sideEffect, 'side-effect', false);
        continue;
      }

      if (!(next?.type === 'word' || isPunct(next, '{') || isPunct(next, '*'))) continue;

      let j = i + 1;
      const typeOnly = isWord(at(j), 'type') && !isWord(at(j + 1), 'from') && !isPunct(at(j + 1), ',') && !isPunct(at(j + 1), '=');
      let depth = 0;
      for (; j < tokens.length && j < i + MAX_CLAUSE_TOKENS; j++) {
        const t = at(j);
        if (!t) break;
        if (t.type === 'punct') {
          if (t.value === '{') depth++;
          else if (t.value === '}') {
            depth--;
            if (depth < 0) break;
          } else if (depth === 0 && (t.value === ';' || t.value === '=')) break;
        } else if (t.type === 'word' && depth === 0) {
          const specifier = stringAt(j + 1);
          if (t.value === 'from' && specifier !== undefined) {
            add(specifier, 'import', typeOnly);
            break;
          }
          if (t.value === 'import' || t.value === 'export') break;
        }
      }
    } else if (token.value === 'export') {
      let j = i + 1;
      let typeOnly = false;
      if (isWord(at(j), 'type') && (isPunct(at(j + 1), '{') || isPunct(at(j + 1), '*'))) {
        typeOnly = true;
        j++;
      }

      if (isPunct(at(j), '*')) {
        let k = j + 1;
        if (isWord(at(k), 'as')) k += 2;
        const specifier = stringAt(k + 1);
        if (isWord(at(k), 'from') && specifier !== undefined) add(specifier, 'export-from', typeOnly);
      } else if (isPunct(at(j), '{')) {
        let depth = 0;
        let k = j;
        for (; k < tokens.length && k < j + MAX_CLAUSE_TOKENS; k++) {
          if (isPunct(at(k), '{')) depth++;
          else if (isPunct(at(k), '}')) {
            depth--;
            if (depth === 0) break;
          }
        }
        const specifier = stringAt(k + 2);
        if (isWord(at(k + 1), 'from') && specifier !== undefined) add(specifier, 'export-from', typeOnly);
      }
    } else if (token.value === 'require' && isPunct(at(i + 1), '(') && !isWord(at(i - 1), 'function')) {
      const specifier = stringAt(i + 2);
      if (specifier !== undefined && isPunct(at(i + 3), ')')) add(specifier, 'require', false);
      else nonLiteralDynamic++;
    }
  }

  return { imports, nonLiteralDynamic };
}
