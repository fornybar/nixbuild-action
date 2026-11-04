import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci-workflow.yml', import.meta.url), 'utf8');

function script(id) {
  const lines = workflow.split('\n');
  const step = lines.findIndex(line => line.trim() === `- id: ${id}`);
  assert.notEqual(step, -1);
  const start = lines.findIndex((line, index) => index > step && line.trim() === 'run: |');
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

function run(id, env) {
  return spawnSync('bash', ['-c', script(id)], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function temporary(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-artifacts-'));
  try {
    fn(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assignments(path) {
  return Object.fromEntries(readFileSync(path, 'utf8').trim().split('\n').map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

const build = { top_attr: 'checks', system: 'x86_64-linux', attr: 'alpha' };
const other = { top_attr: 'packages', system: 'aarch64-linux', attr: 'beta' };
const alpha = { checks: { 'x86_64-linux': { alpha: { success: true, label: 'Alpha' } } } };
const beta = { packages: { 'aarch64-linux': { beta: { success: false, label: 'Beta' } } } };

function merge(directory, expected = [build, other]) {
  const output = join(directory, 'output');
  writeFileSync(output, '');
  const result = run('merge', {
    EXPECTED_BUILDS: JSON.stringify(expected),
    RESULTS_PATH: directory,
    GITHUB_OUTPUT: output,
  });
  return { ...result, output: result.status === 0 ? assignments(output) : readFileSync(output, 'utf8') };
}

function put(directory, name, data) {
  writeFileSync(join(directory, `${name}.json`), JSON.stringify(data));
}

test('artifact identities stay stable across retries and separate namespaces and builds', () => temporary(directory => {
  function namespace(prefix) {
    const output = join(directory, 'namespace');
    writeFileSync(output, '');
    const result = run('artifact-namespace', { PREFIX: prefix, GITHUB_OUTPUT: output });
    assert.equal(result.status, 0, result.stderr);
    return assignments(output).namespace;
  }
  function name(value, scope) {
    const output = join(directory, 'name');
    writeFileSync(output, '');
    const result = run('artifact-name', { BUILD: JSON.stringify(value), NAMESPACE: scope, GITHUB_ENV: output });
    assert.equal(result.status, 0, result.stderr);
    return assignments(output).ARTIFACT_PREFIX;
  }
  const first = namespace('one');
  assert.equal(namespace('one'), first);
  assert.notEqual(namespace('two'), first);
  const initial = name(build, first);
  assert.equal(name({ ...build, label: 'Changed label', name: 'Changed derivation' }, first), initial);
  assert.notEqual(name(build, namespace('two')), initial);
  assert.notEqual(name({ ...build, system: 'aarch64-linux' }, first), initial);
  assert.notEqual(name({ ...build, top_attr: 'packages' }, first), initial);
  assert.notEqual(name({ ...build, attr: 'beta' }, first), initial);
  assert.notEqual(name({ ...build, attr: 'a/b' }, first), name({ ...build, attr: 'a_b' }, first));
}));

test('summary retries preserve inputs and report mixed build success accurately', () => temporary(directory => {
  put(directory, 'alpha', alpha);
  put(directory, 'beta', beta);
  const first = merge(directory);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.output.results), { ...alpha, ...beta });
  assert.equal(first.output.success, 'false');
  const second = merge(directory);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(second.output, first.output);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'alpha.json'))), alpha);
}));

test('a replaced build result changes the summary without losing other builds', () => temporary(directory => {
  put(directory, 'alpha', alpha);
  put(directory, 'beta', beta);
  assert.equal(merge(directory).output.success, 'false');
  const replacement = { packages: { 'aarch64-linux': { beta: { success: true, label: 'Beta' } } } };
  put(directory, 'beta', replacement);
  const result = merge(directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.success, 'true');
  assert.deepEqual(JSON.parse(result.output.results), { ...alpha, ...replacement });
}));

for (const [name, documents, error] of [
  ['missing build', [alpha], 'Build results do not match the expected builds'],
  ['unexpected build', [alpha, beta, { checks: { 'x86_64-linux': { extra: { success: true } } } }], 'Build results do not match the expected builds'],
  ['duplicate build', [alpha, beta, alpha], 'Build results do not match the expected builds'],
  ['missing status', [alpha, { packages: { 'aarch64-linux': { beta: {} } } }], 'Build results must contain a boolean success value'],
  ['non-boolean status', [alpha, { packages: { 'aarch64-linux': { beta: { success: 'true' } } } }], 'Build results must contain a boolean success value'],
]) {
  test(`summary rejects ${name} without publishing outputs`, () => temporary(directory => {
    documents.forEach((document, index) => put(directory, String(index), document));
    const result = merge(directory);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(error), result.stderr);
    assert.equal(result.output, '');
  }));
}

test('summary rejects malformed JSON and an empty download', () => temporary(directory => {
  let result = merge(directory);
  assert.notEqual(result.status, 0);
  assert.equal(result.output, '');
  writeFileSync(join(directory, 'broken.json'), '{');
  result = merge(directory);
  assert.notEqual(result.status, 0);
  assert.equal(result.output, '');
}));
