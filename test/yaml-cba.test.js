import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlError } from '../src/yaml.js';
import { CbaError, hashTerms, normalizeCba, parseCbaText, recommend, windowForModel } from '../src/cba.js';
import { TEMPLATE, cbaText } from './helpers.js';

test('parses nested maps, lists, quoted strings and comments', () => {
  const doc = parseYaml(`
version: "1.0"   # trailing comment
a:
  b:
    c: 3
    d: 'it''s'
    e: "x # not a comment"
  list:
    - one
    - "two"
  same-indent-list:
  - x
  empty:
flag: false
pct: 12.5
nothing: null
`);
  assert.deepEqual(doc, {
    version: '1.0',
    a: { b: { c: 3, d: "it's", e: 'x # not a comment' }, list: ['one', 'two'], 'same-indent-list': ['x'], empty: null },
    flag: false,
    pct: 12.5,
    nothing: null,
  });
});

test('rejects syntax outside the subset with a line number', () => {
  assert.throws(() => parseYaml('a: [1, 2]'), (e) => e instanceof YamlError && e.line === 1 && /unsupported/.test(e.message));
  assert.throws(() => parseYaml('a:\n  b: 1\n c: 2'), YamlError);
  assert.throws(() => parseYaml('a: 1\na: 2'), /duplicate key/);
  assert.throws(() => parseYaml('a: |\n  text'), /unsupported/);
  assert.throws(() => parseYaml('a:\n\t- x'), /tabs/);
});

test('the template is valid and equals the defaults', () => {
  const terms = normalizeCba(parseCbaText(TEMPLATE));
  assert.equal(terms.working_conditions.max_context_saturation_pct, 85);
  assert.equal(hashTerms(terms), hashTerms(normalizeCba({ collective_bargaining_agreement: {} })));
});

test('comment-only edits do not change the hash; value edits do', () => {
  const base = hashTerms(normalizeCba(parseCbaText(TEMPLATE)));
  const commented = TEMPLATE.replace('# How long one contract lasts.', '# How long one contract lasts (edited).');
  assert.equal(hashTerms(normalizeCba(parseCbaText(commented))), base);
  assert.notEqual(hashTerms(normalizeCba(parseCbaText(cbaText({ max_session_turns: 50 })))), base);
});

test('validation reports every problem', () => {
  const doc = parseCbaText(cbaText({ context_warning_pct: 90, work_orders: 'sometimes', allow_palate_cleansers: 'true' }));
  doc.collective_bargaining_agreement.mystery = 1;
  assert.throws(
    () => normalizeCba(doc),
    (e) =>
      e instanceof CbaError &&
      e.problems.some((p) => /context_warning_pct must be lower/.test(p)) &&
      e.problems.some((p) => /work_orders must be one of/.test(p)) &&
      e.problems.some((p) => /palate_cleansers must stay false/.test(p)) &&
      e.problems.some((p) => /unknown field mystery/.test(p)),
  );
});

test('model windows and recommendations', () => {
  assert.equal(windowForModel('claude-opus-5-5'), 200_000);
  assert.equal(windowForModel('claude-opus-5-5[1m]'), 1_000_000);
  assert.equal(windowForModel('mystery-model'), null);
  assert.ok(recommend({ windowTokens: 1_000_000 }).working_conditions.max_context_saturation_pct < 85);
});
