import { openSync, writeFileSync, mkdirSync, closeSync, fstatSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function acquireReceiverLock(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, 'receiver-wrapper.lock');
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('This kit already has a receiver-wrapper lock. Do not restart or overwrite status; have the operator verify the prior run and remove only a confirmed stale test lock.');
    throw error;
  }
  const owned = fstatSync(fd);
  const release = () => {
    if (fd === undefined) return;
    try {
      const current = lstatSync(path);
      if (current.ino === owned.ino && current.dev === owned.dev) unlinkSync(path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { closeSync(fd); fd = undefined; }
  };
  try { writeFileSync(fd, JSON.stringify({ supervisorPid: process.pid, createdAt: new Date().toISOString() }) + '\n'); }
  catch (error) { release(); throw error; }
  return { release };
}
