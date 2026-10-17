import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { capability, orderStatus } from './order-status.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = join(dir, 'node_modules/@nostr-agx/cli/dist/agx.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function checkRuntime() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error('Use Node.js 22.12 or later (Node 24 is recommended), then run npm ci.');
  }
  if (!existsSync(cli)) {
    throw new Error('Local AGX dependency is missing. In this folder run npm ci --ignore-scripts --no-audit --no-fund.');
  }
}

export async function runFixture({ verify = false, signal, onProgress = () => {} } = {}) {
  checkRuntime();
  const root = mkdtempSync(join(tmpdir(), 'agx-get-started-'));
  const audit = join(root, 'receiver-audit.jsonl');
  const children = new Set();
  // Never inherit a user's AGX identity, profile, API credentials or relay override.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGX_')));
  Object.assign(env, { AGX_HOME: root, NO_COLOR: '1', FORCE_COLOR: '0', DEMO_AUDIT_PATH: audit });
  const checkAbort = () => { if (signal?.aborted) throw new Error('Sample interrupted.'); };
  function launch(args) {
    checkAbort();
    const child = spawn(process.execPath, [cli, '--no-color', ...args], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    const state = { child, stdout: '', stderr: '', error: null, closed: false, code: null };
    child.stdout.on('data', data => { state.stdout += data; });
    child.stderr.on('data', data => { state.stderr += data; });
    child.on('error', error => { state.error = error; });
    state.done = new Promise(resolve => child.on('close', code => {
      state.closed = true; state.code = code; children.delete(child); resolve(state);
    }));
    return state;
  }
  async function waitFor(state, predicate, description, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      checkAbort();
      if (predicate(state)) return;
      if (state.closed || state.error) throw new Error(`${description} failed: ${state.error?.message || state.stderr || state.stdout}`);
      await delay(50);
    }
    throw new Error(`${description} timed out. ${state.stderr}`);
  }
  async function command(args, { allowFailure = false, timeout = 45000 } = {}) {
    const state = launch(args);
    await waitFor(state, s => s.closed, 'AGX command', timeout);
    if (!allowFailure && state.code !== 0) throw new Error(`AGX command failed: ${state.stderr || state.stdout}`);
    return state;
  }
  async function stop(state) {
    if (!state || state.closed) return;
    state.child.kill('SIGTERM');
    const timer = setTimeout(() => state.child.kill('SIGKILL'), 3000);
    await state.done;
    clearTimeout(timer);
  }
  const auditRows = () => existsSync(audit) ? readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const identity = async profile => {
    await command(['identity', 'new', '--profile', profile]);
    const state = await command(['--json', 'identity', 'show', '--profile', profile]);
    const value = JSON.parse(state.stdout);
    assert.match(value.npub, /^npub1/);
    return value.npub;
  };
  let receiver;
  const evidence = { cliVersion: null, relay: null, requester: null, receiver: null, completed: false, checks: [] };
  try {
    evidence.cliVersion = (await command(['--version'])).stdout.trim();
    assert.equal(evidence.cliVersion, '0.3.0');
    const relay = launch(['relay', '--port', '0']);
    await waitFor(relay, s => /ws:\/\/127\.0\.0\.1:\d+/.test(s.stdout), 'Loopback relay startup');
    evidence.relay = relay.stdout.match(/ws:\/\/127\.0\.0\.1:\d+/)[0];
    env.AGX_RELAY = evidence.relay;
    // Persist the loopback route as well, so every created profile is explicit.
    evidence.requester = await identity('sample-requester');
    evidence.receiver = await identity('sample-receiver');
    for (const profile of ['sample-requester', 'sample-receiver']) {
      await command(['config', 'set', 'relays', evidence.relay, '--profile', profile]);
    }
    await command(['identity', 'allow', evidence.requester, '--profile', 'sample-receiver']);
    async function startReceiver() {
      const state = launch(['serve', '--profile', 'sample-receiver', '--handler', join(dir, 'handler.mjs'), '--capability', capability, '--no-reply', '--allowed-only', '--full-ids', '--poll-interval', '100']);
      await waitFor(state, s => s.stdout.includes('watching for messages'), 'Receiver startup');
      return state;
    }
    async function request(payload, profile = 'sample-requester', timeout = 30000, allowFailure = false) {
      const state = await command(['--json', 'request', '--profile', profile, '--payload', JSON.stringify(payload), '--timeout', String(timeout), '--', evidence.receiver, capability], { allowFailure, timeout: timeout + 15000 });
      return { state, result: JSON.parse(state.stdout) };
    }
    receiver = await startReceiver();
    onProgress({ phase: 'receiver-ready', relay: evidence.relay });
    checkAbort();
    const first = await request({ orderId: 'DEMO-1001' });
    assert.equal(first.result.ok, true);
    evidence.output = first.result.result;
    assert.deepEqual(evidence.output, orderStatus({ orderId: 'DEMO-1001' }));
    assert.equal(auditRows().length, 1);
    evidence.completed = true;
    evidence.checks.push('allowed requester completed real task with expected output');
    if (verify) {
      const malformed = await request({ orderId: { invalid: true } });
      assert.deepEqual(malformed.result.result, orderStatus({ orderId: {} }));
      const unknown = await request({ orderId: 'DEMO-9999' });
      assert.deepEqual(unknown.result.result, orderStatus({ orderId: 'DEMO-9999' }));
      evidence.checks.push('invalid and unknown records return bounded domain errors');
      await identity('sample-stranger');
      await command(['config', 'set', 'relays', evidence.relay, '--profile', 'sample-stranger']);
      const count = auditRows().length;
      const denied = await request({ orderId: 'DEMO-1001' }, 'sample-stranger', 1800, true);
      assert.notEqual(denied.state.code, 0);
      assert.equal(denied.result.ok, false);
      assert.equal(auditRows().length, count);
      assert.match(receiver.stdout, /DENY/);
      evidence.checks.push('unallowed requester timed out and never executed receiver handler');
      await stop(receiver);
      receiver = await startReceiver();
      await delay(700);
      assert.equal(auditRows().length, count);
      const afterRestart = await request({ orderId: 'DEMO-1002' });
      assert.deepEqual(afterRestart.result.result, orderStatus({ orderId: 'DEMO-1002' }));
      assert.equal(auditRows().length, count + 1);
      evidence.checks.push('normal receiver restart did not rerun completed tasks; fresh task succeeded');
      await stop(receiver);
      const unavailableCount = auditRows().length;
      const unavailable = await request({ orderId: 'DEMO-1003' }, 'sample-requester', 1800, true);
      assert.notEqual(unavailable.state.code, 0);
      assert.equal(auditRows().length, unavailableCount);
      receiver = await startReceiver();
      // A timeout is not cancellation: the queued lookup can execute after restart.
      await waitFor(receiver, () => auditRows().length > unavailableCount, 'Queued read-only lookup recovery');
      const retry = await request({ orderId: 'DEMO-1003' });
      assert.deepEqual(retry.result.result, orderStatus({ orderId: 'DEMO-1003' }));
      evidence.checks.push('unavailable receiver timed out; queued lookup and deliberate read-only retry completed after restart');
    }
    return evidence;
  } finally {
    await Promise.all([...children].map(child => stop({ child, get closed() { return child.exitCode !== null || child.signalCode !== null; }, done: once(child, 'close') })));
    rmSync(root, { recursive: true, force: true });
    evidence.cleanedUp = !existsSync(root);
    onProgress({ phase: 'cleaned-up', cleanedUp: evidence.cleanedUp });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length > 2) {
    console.error('This isolated sample accepts no arguments. Use npm run sample.');
    process.exit(1);
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    console.log('Running a real AGX task using temporary identities and a loopback relay.');
    const result = await runFixture({ signal: controller.signal });
    console.log(JSON.stringify(result, null, 2));
    console.log('Sample complete. Receiver and relay stopped; temporary identities removed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
