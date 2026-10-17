import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { supervise, groupIsRunning, stopAfterTask } from './supervise.mjs';
import { prepareRequest } from './request-plan.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = join(dir, 'node_modules/@nostr-agx/cli/dist/agx.js');

for (const failModel of [false, true]) test(`real loopback AGX exchange ${failModel ? 'returns a model error' : 'returns a clean result'} and disconnects automatically`, { timeout: 60000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'agx-bridge-exchange-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGX_')));
  Object.assign(env, { AGX_HOME: home, NO_COLOR: '1' });
  const children = new Set();
  let pgid, requestPgid, receiverDone, requestDone;
  function launch(args) {
    const child = spawn(process.execPath, [cli, '--no-color', ...args], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    const state = { child, stdout: '', stderr: '', ended: false };
    child.stdout.on('data', data => { state.stdout += data; });
    child.stderr.on('data', data => { state.stderr += data; });
    state.done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => { state.ended = true; children.delete(child); resolve({ ...state, code }); });
    });
    return state;
  }
  async function run(args) {
    const result = await launch(args).done;
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return result.stdout;
  }
  async function waitFor(predicate, name, ms = 15000) {
    const until = Date.now() + ms;
    while (!predicate() && Date.now() < until) await delay(25);
    assert(predicate(), `Timed out waiting for ${name}`);
  }
  try {
    const relay = launch(['relay', '--port', '0']);
    await waitFor(() => /ws:\/\/127\.0\.0\.1:\d+/.test(relay.stdout), 'loopback relay');
    env.AGX_RELAY = relay.stdout.match(/ws:\/\/127\.0\.0\.1:\d+/)[0];
    const identities = {};
    for (const profile of ['requester', 'receiver']) {
      await run(['identity', 'new', '--profile', profile]);
      identities[profile] = JSON.parse(await run(['--json', 'identity', 'show', '--profile', profile])).npub;
      await run(['config', 'set', 'relays', env.AGX_RELAY, '--profile', profile]);
    }
    await run(['identity', 'allow', identities.requester, '--profile', 'receiver']);
    const startedFile = join(home, 'model-started');
    const stub = join(home, 'hermes-stub');
    writeFileSync(stub, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[1]!=='--toolsets'||args[2]!==' ')process.exit(2);const nonce=args.at(-1).match(/confirmation token ([a-zA-Z0-9_-]+)\\./)[1];fs.writeFileSync(${JSON.stringify(startedFile)},String(process.pid));process.on('SIGTERM',()=>{});setTimeout(()=>{if(${failModel}){console.error('Synthetic provider unavailable');process.exit(3);}console.log('Warning: Unknown toolsets: ');console.log('The synthetic task completed. '+nonce);console.log('Session: test-only');},1500);`, { mode: 0o700 });
    env.HERMES_TEST_BIN = stub;
    let receiverOutput = '';
    receiverDone = supervise(process.execPath, [cli, '--no-color', 'serve', '--profile', 'receiver', '--handler', join(dir, 'hermes-handler.mjs'), '--capability', 'hermes.summarize', '--no-reply', '--allowed-only', '--full-ids', '--poll-interval', '100'], {
      cwd: home, env, lifetimeMs: 25000, graceMs: 300, handleSignals: false,
      shouldStop: stopAfterTask(join(home, 'profiles/receiver/state.json')),
      onStart: ({ pid }) => { pgid = pid; }, onOutput: (_, data) => { receiverOutput += data; },
    });
    // Attach a rejection handler immediately, even if startup fails early.
    receiverDone.catch(() => {});
    await waitFor(() => receiverOutput.includes('watching for messages'), 'receiver');
    const plan = prepareRequest(identities.receiver);
    let requestStdout = '', requestStderr = '';
    requestDone = supervise(process.execPath, [cli, '--no-color', '--json', 'request', '--profile', 'requester', '--payload', JSON.stringify(plan.payload), '--timeout', '15000', '--', plan.to, plan.capability], {
      cwd: home, env, lifetimeMs: 20000, graceMs: 300, handleSignals: false,
      onStart: ({pid}) => { requestPgid = pid; },
      onOutput: (stream, data) => { if (stream === 'stdout') requestStdout += data; else requestStderr += data; },
    });
    requestDone.catch(() => {});
    await waitFor(() => existsSync(startedFile), 'Hermes subprocess');
    assert(await groupIsRunning(pgid), 'receiver must remain alive while its model turn runs');
    const response = await requestDone;
    assert(response.disconnected);assert.equal(await groupIsRunning(requestPgid),false);
    const result = JSON.parse(requestStdout);
    if (failModel) {
      assert.notEqual(response.code, 0); assert.equal(result.ok, false);
      assert(!requestStdout.includes('Synthetic provider unavailable'), 'provider diagnostics must not be returned to requester');
    } else {
      assert.equal(response.code, 0, requestStderr || requestStdout);
      assert(result.ok); assert.equal(result.result.runtime, 'hermes-cli');
      assert.equal(result.result.nonce, plan.payload.nonce);
      assert.equal(result.result.summary, `The synthetic task completed. ${plan.payload.nonce}`);
    }
    const stopped = await receiverDone;
    assert.equal(stopped.reason, 'task-finished'); assert(stopped.disconnected);
    assert.equal(await groupIsRunning(pgid), false);
    assert.equal(JSON.parse(readFileSync(join(home, 'profiles/receiver/state.json'), 'utf8')).stats.tasks, 1);
  } finally {
    if (pgid) { try { process.kill(-pgid, 'SIGKILL'); } catch {} }
    if (requestPgid) { try { process.kill(-requestPgid, 'SIGKILL'); } catch {} }
    for (const child of children) child.kill('SIGKILL');
    await Promise.allSettled([...children].map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('close', resolve);
    })));
    if (receiverDone) await receiverDone.catch(() => {});
    if (requestDone) await requestDone.catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});
