import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';

const execute = promisify(execFile);

export function stopAfterTask(statePath) {
  const count = () => {
    try { return JSON.parse(readFileSync(statePath, 'utf8')).stats?.tasks ?? 0; }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  };
  const baseline = count();
  return () => count() > baseline;
}

function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export async function groupIsRunning(pgid) {
  try { process.kill(-pgid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  // Exited zombies cannot hold sockets. Read only group IDs and process states,
  // never another process's arguments, environment, or working directory.
  const { stdout } = await execute('ps', ['-axo', 'pgid=,stat='], { timeout: 3000, maxBuffer: 1024 * 1024 });
  return stdout.split('\n').some(line => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === pgid && state && !state.startsWith('Z');
  });
}

export async function supervise(file, args, {
  cwd, env = process.env, lifetimeMs = 600000, graceMs = 2000,
  killWaitMs = 3000, pollMs = 100, shouldStop = () => false,
  onStart = () => {}, onOutput,
  handleSignals = true,
} = {}) {
  if (process.platform === 'win32') throw new Error('This process-group supervisor requires macOS or Linux.');
  const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let code, signal, ended = false, closed = false, spawnError, reason, failure;
  const stop = value => { reason ??= value; };
  child.on('error', error => { spawnError = error; ended = true; stop('spawn-error'); });
  child.on('exit', (value, sig) => { code = value; signal = sig; ended = true; stop('receiver-exit'); });
  child.on('close', () => { closed = true; });
  const outputError = error => { failure ??= error; stop('output-error'); };
  const forward = onOutput ?? ((stream, data) => process[stream].write(data));
  for (const name of ['stdout', 'stderr']) {
    child[name].on('error', outputError);
    child[name].on('data', data => { try { forward(name, data); } catch (error) { outputError(error); } });
    // The parent may print a preview/status while this child is captured. A
    // queued EPIPE there must also trigger cleanup of the active group.
    process[name].on('error', outputError);
  }
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(sig => [sig, () => stop(sig)]));
  if (handleSignals) for (const [sig, fn] of handlers) process.on(sig, fn);
  const deadline = Date.now() + lifetimeMs;
  const timer = setTimeout(() => stop('deadline'), lifetimeMs);
  try {
    if (child.pid) await onStart({ pid: child.pid, deadline: new Date(deadline).toISOString() });
    while (!reason) {
      if (await shouldStop()) stop('task-finished');
      if (!reason) await delay(pollMs);
    }
  } catch (error) { failure = error; }
  finally {
    clearTimeout(timer);
    try {
      if (child.pid) {
        signalGroup(child.pid, 'SIGTERM');
        const gracefulUntil = Date.now() + graceMs;
        while (Date.now() < gracefulUntil && await groupIsRunning(child.pid)) await delay(25);
        // Do not cancel escalation when the immediate child exits. Its nested
        // Hermes process may still be alive and ignoring graceful termination.
        if (await groupIsRunning(child.pid)) signalGroup(child.pid, 'SIGKILL');
        const killUntil = Date.now() + killWaitMs;
        while ((!ended || !closed || await groupIsRunning(child.pid)) && Date.now() < killUntil) await delay(25);
        if (!ended || !closed || await groupIsRunning(child.pid)) throw new Error('Test process group cleanup could not be verified; inspect this group before another test.');
      }
    } catch (error) {
      // Even a denied/unavailable process inspection must not leave this test
      // running. Force-stop our group, then report that verification failed.
      if (child.pid) signalGroup(child.pid, 'SIGKILL');
      throw error;
    } finally {
      if (handleSignals) for (const [sig, fn] of handlers) process.removeListener(sig, fn);
      for (const name of ['stdout', 'stderr']) process[name].removeListener('error', outputError);
    }
  }
  if (spawnError) throw spawnError;
  if (failure) throw failure;
  return { reason, code, signal, pgid: child.pid, disconnected: true };
}
