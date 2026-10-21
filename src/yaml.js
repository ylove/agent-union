// A strict subset of YAML, enough for union-policy.yaml: nested maps, block lists of scalars,
// quoted/plain scalars and comments. Anything outside the subset is an error, not a guess.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.line = line;
  }
}

const SUBSET =
  'supported: "key: value" maps (2+ space indents), "- item" lists of scalars, quoted strings, numbers, true/false, null, # comments';

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

export function parseScalar(raw, line) {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) throw new YamlError('unterminated double-quoted string', line);
    try {
      return JSON.parse(v);
    } catch {
      throw new YamlError(`invalid double-quoted string ${v}`, line);
    }
  }
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) throw new YamlError('unterminated single-quoted string', line);
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[[{|>&*!]/.test(v)) {
    throw new YamlError(`unsupported YAML syntax "${v[0]}" (${SUBSET})`, line);
  }
  if (/^[-+]?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+)$/.test(v)) return Number.parseFloat(v);
  return v;
}

function tokenize(text) {
  const out = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((rawLine, i) => {
    const line = i + 1;
    if (rawLine.includes('\t')) {
      const before = rawLine.slice(0, rawLine.search(/\S|$/));
      if (before.includes('\t')) throw new YamlError('tabs are not allowed for indentation', line);
    }
    const content = stripComment(rawLine).replace(/\s+$/, '');
    if (content.trim() === '' || (i === 0 && content.trim() === '---')) return;
    if (content.trim() === '---' || content.trim() === '...') {
      throw new YamlError('multiple documents are not supported', line);
    }
    const indent = content.search(/\S/);
    out.push({ indent, text: content.slice(indent), line });
  });
  return out;
}

export function parseYaml(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return {};
  let pos = 0;

  function parseBlock(indent) {
    const first = tokens[pos];
    if (first.text.startsWith('- ') || first.text === '-') return parseList(indent);
    return parseMap(indent);
  }

  function parseList(indent) {
    const list = [];
    while (pos < tokens.length && tokens[pos].indent === indent) {
      const t = tokens[pos];
      // A key at the same indent ends a list written flush with its parent key ("key:\n- a\nnext: 1").
      if (!(t.text.startsWith('- ') || t.text === '-')) break;
      const item = t.text.slice(1).trim();
      if (item === '' || /^[^"'][^:]*:(\s|$)/.test(item)) {
        throw new YamlError(`list items must be scalars (${SUBSET})`, t.line);
      }
      list.push(parseScalar(item, t.line));
      pos++;
    }
    if (pos < tokens.length && tokens[pos].indent > indent) {
      throw new YamlError('unexpected indentation inside a list', tokens[pos].line);
    }
    return list;
  }

  function parseMap(indent) {
    const map = {};
    while (pos < tokens.length && tokens[pos].indent === indent) {
      const t = tokens[pos];
      if (t.text.startsWith('- ')) throw new YamlError('unexpected list item in a map', t.line);
      const m = /^([A-Za-z0-9_.-]+|"[^"]*"|'[^']*'):(?:\s+(.*))?$/.exec(t.text);
      if (!m) throw new YamlError(`expected "key: value" (${SUBSET})`, t.line);
      const key = m[1].startsWith('"') || m[1].startsWith("'") ? m[1].slice(1, -1) : m[1];
      if (Object.hasOwn(map, key)) throw new YamlError(`duplicate key "${key}"`, t.line);
      pos++;
      const rest = m[2]?.trim() ?? '';
      if (rest !== '') {
        map[key] = parseScalar(rest, t.line);
        continue;
      }
      if (pos < tokens.length && tokens[pos].indent > indent) {
        map[key] = parseBlock(tokens[pos].indent);
      } else if (
        pos < tokens.length &&
        tokens[pos].indent === indent &&
        (tokens[pos].text.startsWith('- ') || tokens[pos].text === '-')
      ) {
        // "key:" followed by a list at the same indent, which YAML allows.
        map[key] = parseList(indent);
      } else {
        map[key] = null;
      }
    }
    if (pos < tokens.length && tokens[pos].indent > indent) {
      throw new YamlError('unexpected indentation', tokens[pos].line);
    }
    return map;
  }

  const root = parseBlock(tokens[0].indent);
  if (pos < tokens.length) throw new YamlError('unexpected dedent below the top level', tokens[pos].line);
  return root;
}
