import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nip19 } from 'nostr-tools';

export const sampleText = 'The fictional Northstar team finished the database migration on Tuesday. The test suite passed. Morgan will review the release notes on Thursday before the Friday launch.';

export function publicKey(value) {
  if (!/^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(value || '')) throw new Error('Supply the full public npub from the other operator.');
  try {
    const key = nip19.decode(value);
    if (key.type !== 'npub' || key.data.length !== 64) throw new Error();
  } catch { throw new Error('The public npub is invalid or its checksum does not match.'); }
  return value;
}

export function requestDigest(plan) {
  validateRequest(plan);
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

export function prepareRequest(to, now = Date.now()) {
  return {
    version: 1, to: publicKey(to), capability: 'hermes.summarize',
    payload: { text: sampleText, nonce: 'agx-' + randomBytes(8).toString('hex') },
    timeoutMs: 120000, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 300000).toISOString(),
  };
}

export function validateRequest(plan, now = Date.now()) {
  if (!plan || Object.keys(plan).sort().join() !== 'capability,createdAt,expiresAt,payload,timeoutMs,to,version' ||
      plan.version !== 1 || plan.capability !== 'hermes.summarize' || plan.timeoutMs !== 120000 ||
      !plan.payload || Object.keys(plan.payload).sort().join() !== 'nonce,text' || plan.payload.text !== sampleText ||
      !/^agx-[a-f0-9]{16}$/.test(plan.payload.nonce)) throw new Error('Request plan differs from the fixed synthetic test.');
  publicKey(plan.to);
  const created = Date.parse(plan.createdAt), expires = Date.parse(plan.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires - created !== 300000 ||
      created > now || now >= expires) throw new Error('Request plan expired or has invalid timestamps. Do not automatically retry.');
  return plan;
}

export function claimRequest(plan, agxHome) {
  validateRequest(plan);
  const attempts = join(agxHome, 'request-attempts');
  mkdirSync(attempts, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(attempts, plan.payload.nonce), JSON.stringify({ attemptedAt: new Date().toISOString(), to: plan.to, digest: requestDigest(plan) }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('This request was already attempted. Do not resend after a timeout; diagnose first.');
    throw error;
  }
}
