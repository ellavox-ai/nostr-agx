import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeWithHermes, buildPrompt, parseHermesOutput } from './hermes-handler.mjs';
import { prepareRequest, validateRequest, claimRequest } from './request-plan.mjs';
import { nip19 } from 'nostr-tools';

test('Hermes bridge preserves argument boundaries, limits and cleanup', async () => {
  let cwd;
  const payload = { text: 'Synthetic text with $(not-a-command) and `literal` content.', nonce: 'test-123' };
  const result = await summarizeWithHermes(payload, { taskId: 'task-123' }, async (bin, args, options) => {
    assert.equal(bin, process.env.HERMES_TEST_BIN || 'hermes');
    assert.deepEqual(args.slice(0, 8), ['chat', '--toolsets', ' ', '--ignore-rules', '--max-turns', '2', '-Q', '-q']);
    assert.match(args[8], /\$\(not-a-command\)/);
    assert.equal(options.timeout, 90000);
    cwd = options.cwd; assert(existsSync(cwd));
    return { stdout: '\u001b[31mWarning: Unknown toolsets: \u001b[0m\nA synthetic summary. test-123\nSession: demo\n' };
  });
  assert.equal(result.nonce, 'test-123');
  assert.equal(result.taskId, 'task-123');
  assert.equal(result.summary, 'A synthetic summary. test-123');
  assert(!existsSync(cwd));
});

test('only the known blank toolset diagnostic is removed', () => {
  assert.equal(parseHermesOutput('Warning: Unknown toolsets: \r\nClean summary. token-1\r\nSession ID: ignored', 'token-1'), 'Clean summary. token-1');
  assert.throws(() => parseHermesOutput('Warning: Unknown toolsets: terminal\nSummary. token-1', 'token-1'), /Unexpected Hermes diagnostic/);
  assert.throws(() => parseHermesOutput('Warning: provider authentication failed\ntoken-1', 'token-1'), /Unexpected Hermes diagnostic/);
});

test('a gateway-launched handler pins the child workspace without changing its parent environment', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agx-gateway-env-test-'));
  const stub = join(fixture, 'hermes.cjs');
  writeFileSync(stub, `const assert=require('node:assert/strict');
const {realpathSync}=require('node:fs');
assert.equal(Object.hasOwn(process.env,'_HERMES_GATEWAY'),false);
assert.equal(Object.hasOwn(process.env,'MESSAGING_CWD'),false);
assert.equal(Object.hasOwn(process.env,'OLDPWD'),false);
assert.equal(realpathSync(process.env.TERMINAL_CWD),realpathSync(process.cwd()));
assert.equal(realpathSync(process.env.PWD),realpathSync(process.cwd()));
assert.equal(process.env.HERMES_SESSION_SOURCE,'tool');
assert.equal(process.env.AGX_TEST_AUTH_SENTINEL,'synthetic-auth-preserved');
console.log('Synthetic summary. gateway-test');`);
  const inherited = {
    _HERMES_GATEWAY: '1', TERMINAL_CWD: fixture, MESSAGING_CWD: fixture,
    PWD: fixture, OLDPWD: fixture, AGX_TEST_AUTH_SENTINEL: 'synthetic-auth-preserved',
  };
  const previous = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
  let cwd;
  try {
    Object.assign(process.env, inherited);
    const result = await summarizeWithHermes({ text: 'Fictional gateway task.', nonce: 'gateway-test' }, { taskId: 'gateway-test' }, async (_, args, options) => {
      cwd = options.cwd;
      return promisify(execFile)(process.execPath, [stub, ...args], options);
    });
    assert.equal(result.summary, 'Synthetic summary. gateway-test');
    for (const [key, value] of Object.entries(inherited)) assert.equal(process.env[key], value, `parent ${key} changed`);
    assert(!existsSync(cwd));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('reviewed plan stays fixed, expires, and can only be attempted once', () => {
  const home = mkdtempSync(join(tmpdir(), 'agx-plan-test-'));
  try {
    const plan = prepareRequest(nip19.npubEncode('11'.repeat(32)));
    assert.throws(() => prepareRequest('npub1' + 'q'.repeat(58)), /checksum/);
    assert.equal(validateRequest(plan), plan);
    assert.throws(() => validateRequest({ ...plan, payload: { ...plan.payload, text: 'other text' } }), /fixed synthetic test/);
    assert.throws(() => validateRequest(plan, Date.parse(plan.expiresAt)), /expired/);
    claimRequest(plan, home);
    assert.throws(() => claimRequest(plan, home), /already attempted/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('invalid payload and missing nonce result do not become success', async () => {
  assert.throws(() => buildPrompt({ text: 'hello', nonce: 'invalid token' }));
  await assert.rejects(summarizeWithHermes({ text: 'hello', nonce: 'test-456' }, { taskId: 'id' }, async () => ({ stdout: 'unconfirmed' })), /confirmation/);
});
