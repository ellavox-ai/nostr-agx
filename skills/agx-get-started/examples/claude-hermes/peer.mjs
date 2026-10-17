import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supervise, stopAfterTask } from './supervise.mjs';
import { prepareRequest, validateRequest, claimRequest, publicKey, requestDigest } from './request-plan.mjs';
import { acquireReceiverLock } from './receiver-lock.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = join(dir, 'node_modules/@nostr-agx/cli/dist/agx.js');
const relay = 'wss://nos.lol';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGX_')));
Object.assign(env, { AGX_HOME: join(dir, '.agx-test'), AGX_RELAY: relay, NO_COLOR: '1' });
const command = process.argv[2];
const role = process.argv[3];
const validRoles = new Set(['requester', 'receiver']);
const planPath = join(dir, 'request-plan.json');
if (!existsSync(cli)) throw new Error('In this folder run npm ci --ignore-scripts --no-audit --no-fund first.');

async function run(args, { allowFailure = false, lifetimeMs = 30000 } = {}) {
  let stdout = '', stderr = '';
  const result = await supervise(process.execPath, [cli, '--no-color', ...args], {
    cwd: dir, env, lifetimeMs,
    onOutput: (stream, data) => { if (stream === 'stdout') stdout += data; else stderr += data; },
  });
  if (result.reason !== 'receiver-exit') throw new Error(`AGX command stopped (${result.reason}); do not automatically retry.`);
  if ((result.code !== 0 || result.signal) && !allowFailure) throw new Error(stderr || stdout || 'AGX command failed; inspect the receiver output.');
  return { ...result, stdout, stderr };
}
async function publicIdentity(profile) {
  const value = await run(['--json', 'identity', 'show', '--profile', profile]);
  return JSON.parse(value.stdout).npub;
}
try {
  if (command === 'init' && validRoles.has(role)) {
    const exists = await run(['--json', 'identity', 'show', '--profile', role], { allowFailure: true });
    if (exists.code !== 0) await run(['identity', 'new', '--profile', role]);
    await run(['config', 'set', 'relays', relay, '--profile', role]);
    console.log(JSON.stringify({ role, npub: await publicIdentity(role), relay, capability: role === 'receiver' ? 'hermes.summarize' : undefined }, null, 2));
  } else if (command === 'serve') {
    const requester = publicKey(role);
    const lease = acquireReceiverLock(env.AGX_HOME);
    let launched = false, cleanedUp = false;
    try {
      if (existsSync(join(env.AGX_HOME, 'profiles', 'receiver', 'serve.lock'))) throw new Error('This isolated profile has a CLI serve lock. Ask the operator to verify the prior receiver; do not overwrite its status or restart it.');
      await publicIdentity('receiver');
      let allowed = JSON.parse((await run(['--json', 'identity', 'allow', '--list', '--profile', 'receiver'])).stdout).allow;
      if (allowed.some(peer => peer !== requester)) throw new Error('Unexpected peer in this test receiver allowlist; do not start until reviewed.');
      if (!allowed.length) await run(['identity', 'allow', requester, '--profile', 'receiver']);
      allowed = JSON.parse((await run(['--json', 'identity', 'allow', '--list', '--profile', 'receiver'])).stdout).allow;
      if (allowed.length !== 1 || allowed[0] !== requester) throw new Error('The receiver must allow exactly the selected requester.');
      const statePath = join(env.AGX_HOME, 'profiles', 'receiver', 'state.json');
      const shouldStop = stopAfterTask(statePath);
      const statusPath = join(env.AGX_HOME, 'receiver-status.json');
      let status = { disconnected: false, startedAt: new Date().toISOString(), requester, receiver: await publicIdentity('receiver'), relay };
      const saveStatus = () => writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n', { mode: 0o600 });
      mkdirSync(env.AGX_HOME, { recursive: true, mode: 0o700 });
      saveStatus();
      console.log('One allowed requester and one model call. Disconnect after the task result publication attempt, or at the 10-minute deadline.');
      const result = await supervise(process.execPath, [cli, '--no-color', 'serve', '--profile', 'receiver', '--handler', join(dir, 'hermes-handler.mjs'), '--capability', 'hermes.summarize', '--no-reply', '--allowed-only', '--full-ids', '--poll-interval', '1500'], {
        cwd: dir, env,
        onStart: ({ pid, deadline }) => {
          launched = true;
          status = { ...status, supervisorPid: process.pid, receiverPid: pid, pgid: pid, deadline };
          saveStatus(); console.log(JSON.stringify(status, null, 2));
        },
        // CLI 0.3.0 persists stats only AFTER awaiting the handler AND its task
        // result publication attempt. A locally printed summary is insufficient.
        shouldStop,
      });
      cleanedUp = result.disconnected;
      status = { ...status, ...result, disconnectedAt: new Date().toISOString() }; saveStatus();
      console.log('DISCONNECTED: no running process remains in the test receiver group.');
      if (result.reason === 'receiver-exit' && result.code !== 0) throw new Error('The receiver exited before completing a task; inspect its output.');
    } finally {
      // Retain a lock if group cleanup could not be verified. An operator must
      // inspect that run before deliberately clearing a stale test lock.
      if (!launched || cleanedUp) lease.release();
    }
  } else if (command === 'prepare') {
    const plan = prepareRequest(role);
    writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(plan, null, 2));
    console.log('Review digest: ' + requestDigest(plan));
    console.log('Prepared only; nothing sent. Review request-plan.json, then use node peer.mjs send REVIEWED_DIGEST once through normal host permissions.');
  } else if (command === 'request' || command === 'send') {
    if (command === 'send' && (!/^[a-f0-9]{64}$/.test(role || '') || process.argv.length !== 4)) throw new Error('send requires the exact SHA-256 digest displayed with the reviewed plan.');
    const plan = command === 'request' ? prepareRequest(role) : validateRequest(JSON.parse(readFileSync(planPath, 'utf8')));
    if (command === 'send' && requestDigest(plan) !== role) throw new Error('The request plan changed after review. Nothing sent; inspect it again rather than retrying.');
    const { to: receiver, payload } = plan;
    console.log(JSON.stringify(plan, null, 2));
    claimRequest(plan, env.AGX_HOME);
    const result = await run(['--json', 'request', '--profile', 'requester', '--payload', JSON.stringify(payload), '--timeout', '120000', '--', receiver, 'hermes.summarize'], { lifetimeMs: 150000 });
    const value = JSON.parse(result.stdout);
    if (!value.ok || value.result?.runtime !== 'hermes-cli' || value.result?.nonce !== payload.nonce || !value.result?.summary?.includes(payload.nonce)) throw new Error('The expected fresh Hermes result was not received.');
    console.log(JSON.stringify({ verified: true, ...value }, null, 2));
  } else {
    throw new Error('Use: node peer.mjs init requester | init receiver | serve REQUESTER_NPUB | prepare RECEIVER_NPUB | send REVIEWED_DIGEST | request RECEIVER_NPUB');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
