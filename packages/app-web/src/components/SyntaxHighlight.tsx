/**
 * Lightweight syntax highlighter for TypeScript / shell snippets.
 * Single-pass tokenizer — no external dependencies.
 */

type TokenType =
  | 'comment'
  | 'string'
  | 'keyword'
  | 'type'
  | 'number'
  | 'operator'
  | 'function'
  | 'property'
  | 'shell-cmd'
  | 'package'
  | 'plain';

interface Token {
  type: TokenType;
  value: string;
}

const TS_KEYWORDS = new Set([
  'import',
  'export',
  'from',
  'default',
  'const',
  'let',
  'var',
  'async',
  'await',
  'return',
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'new',
  'this',
  'super',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'try',
  'catch',
  'throw',
  'finally',
  'true',
  'false',
  'null',
  'undefined',
  'void',
  'extends',
  'implements',
  'typeof',
  'instanceof',
  'static',
  'public',
  'private',
  'protected',
  'readonly',
]);

const SHELL_CMDS = new Set(['npm', 'npx', 'node', 'yarn', 'pnpm', 'install', 'run', 'exec']);

function tokenizeTS(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < code.length) {
    // Single-line comment
    if (code[i] === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      const value = end === -1 ? code.slice(i) : code.slice(i, end);
      tokens.push({ type: 'comment', value });
      i += value.length;
      continue;
    }

    // Template literal (back-tick)
    if (code[i] === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== '`') {
        if (code[j] === '\\') j++;
        j++;
      }
      tokens.push({ type: 'string', value: code.slice(i, j + 1) });
      i = j + 1;
      continue;
    }

    // Single or double-quoted string
    if (code[i] === '"' || code[i] === "'") {
      const q = code[i];
      let j = i + 1;
      while (j < code.length && code[j] !== q && code[j] !== '\n') {
        if (code[j] === '\\') j++;
        j++;
      }
      tokens.push({ type: 'string', value: code.slice(i, j + 1) });
      i = j + 1;
      continue;
    }

    // Number
    if (/[0-9]/.test(code[i]) && (i === 0 || !/\w/.test(code[i - 1]))) {
      let j = i;
      while (j < code.length && /[\d._xXaAbBcCdDeEfFnN]/.test(code[j])) j++;
      tokens.push({ type: 'number', value: code.slice(i, j) });
      i = j;
      continue;
    }

    // Word (identifier / keyword / type)
    if (/[a-zA-Z_$]/.test(code[i])) {
      let j = i;
      while (j < code.length && /[\w$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      i = j;

      // Peek ahead: if followed by '(' it's a function call
      let k = j;
      while (k < code.length && code[k] === ' ') k++;
      const isCall = code[k] === '(';

      // Peek behind: if preceded by '.' it's a property/method
      const isProp = tokens.length > 0 && tokens[tokens.length - 1].value === '.';

      let type: TokenType;
      if (TS_KEYWORDS.has(word)) {
        type = 'keyword';
      } else if (/^[A-Z]/.test(word)) {
        type = 'type'; // PascalCase → type/class
      } else if (isProp) {
        type = isCall ? 'function' : 'property';
      } else if (isCall) {
        type = 'function';
      } else {
        type = 'plain';
      }

      tokens.push({ type, value: word });
      continue;
    }

    // Default: single char (operator, punctuation, whitespace)
    const ch = code[i];
    const last = tokens[tokens.length - 1];
    if (last && last.type === 'plain' && /\s/.test(ch) && /\s/.test(last.value.at(-1) ?? '')) {
      last.value += ch;
    } else {
      tokens.push({ type: 'plain', value: ch });
    }
    i++;
  }

  return tokens;
}

function tokenizeSH(code: string): Token[] {
  const tokens: Token[] = [];
  for (const line of code.split('\n')) {
    if (tokens.length > 0) tokens.push({ type: 'plain', value: '\n' });

    // Shell comment
    if (line.trimStart().startsWith('#')) {
      tokens.push({ type: 'comment', value: line });
      continue;
    }

    // Tokenise shell words
    let i = 0;
    while (i < line.length) {
      // @package/name
      if (line[i] === '@') {
        let j = i + 1;
        while (j < line.length && /[\w\-/]/.test(line[j])) j++;
        tokens.push({ type: 'package', value: line.slice(i, j) });
        i = j;
        continue;
      }
      // word
      if (/\S/.test(line[i])) {
        let j = i;
        while (j < line.length && /\S/.test(line[j])) j++;
        const word = line.slice(i, j);
        i = j;
        if (SHELL_CMDS.has(word)) {
          tokens.push({ type: 'shell-cmd', value: word });
        } else if (word.startsWith('-')) {
          tokens.push({ type: 'property', value: word });
        } else {
          tokens.push({ type: 'plain', value: word });
        }
        continue;
      }
      tokens.push({ type: 'plain', value: line[i] });
      i++;
    }
  }
  return tokens;
}

const COLOR: Record<TokenType, string> = {
  comment: '#546e7a',
  string: '#c3e88d',
  keyword: '#c792ea',
  type: '#ffcb6b',
  number: '#f78c6c',
  operator: '#89ddff',
  function: '#82aaff',
  property: '#89ddff',
  'shell-cmd': '#82aaff',
  package: '#c3e88d',
  plain: '#e2e8f0',
};

interface SyntaxHighlightProps {
  code: string;
  lang?: 'ts' | 'sh';
  style?: React.CSSProperties;
}

export function SyntaxHighlight({ code, lang = 'ts', style }: SyntaxHighlightProps) {
  const tokens = lang === 'sh' ? tokenizeSH(code) : tokenizeTS(code);

  return (
    <pre
      style={{
        margin: 0,
        padding: 16,
        fontSize: 12,
        lineHeight: 1.7,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        overflowX: 'auto',
        whiteSpace: 'pre',
        ...style,
      }}
    >
      {tokens.map((tok, idx) => (
        <span key={idx} style={{ color: COLOR[tok.type] }}>
          {tok.value}
        </span>
      ))}
    </pre>
  );
}
