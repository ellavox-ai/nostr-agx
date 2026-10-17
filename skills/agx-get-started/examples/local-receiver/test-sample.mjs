import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runFixture } from './run-sample.mjs';
import { orderStatus } from './order-status.mjs';

test('real CLI exchange, denial, restart, timeout and read-only recovery', { timeout: 120000 }, async () => {
  const personalHome = mkdtempSync(join(tmpdir(), 'agx-personal-sentinel-'));
  writeFileSync(join(personalHome, 'sentinel'), 'leave this profile alone');
  const overrides = { AGX_HOME: personalHome, AGX_RELAY: 'ws://127.0.0.1:9', AGX_PROFILE: 'personal', AGX_API_KEY: 'fake-test-key' };
  const before = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const evidence = await runFixture({ verify: true });
    assert.equal(evidence.completed, true);
    assert.equal(evidence.cleanedUp, true);
    assert.equal(evidence.checks.length, 5);
    assert.deepEqual(readdirSync(personalHome), ['sentinel']);
    assert.equal(readFileSync(join(personalHome, 'sentinel'), 'utf8'), 'leave this profile alone');
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(personalHome, { recursive: true, force: true });
  }
});

test('interruption after receiver startup cleans up the fixture', { timeout: 30000 }, async () => {
  const controller = new AbortController();
  let cleanedUp = false;
  await assert.rejects(runFixture({ signal: controller.signal, onProgress(event) {
    if (event.phase === 'receiver-ready') controller.abort();
    if (event.phase === 'cleaned-up') cleanedUp = event.cleanedUp;
  } }), /interrupted/);
  assert.equal(cleanedUp, true);
});

test('lookup rejects arbitrary input without reflecting it', () => {
  for (const payload of [null, {}, { orderId: '__proto__' }, { orderId: 'x'.repeat(10000) }, { orderId: 1001 }]) {
    assert.deepEqual(orderStatus(payload), { source: 'agx-get-started-demo', demo: true, found: false, error: 'invalid-order-id' });
  }
});

test('runner cannot accept real peer/profile arguments', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run-sample.mjs', import.meta.url)), '--profile', 'personal'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /accepts no arguments/);
});
