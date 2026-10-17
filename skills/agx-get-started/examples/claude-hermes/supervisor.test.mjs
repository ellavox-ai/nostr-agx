import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { supervise, groupIsRunning } from './supervise.mjs';

const quiet = () => {};
const live = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };

test('deadline removes a TERM-resistant root and child without touching unrelated processes', { timeout: 12000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'agx-supervise-test-'));
  const childFile = join(home, 'child.cjs'), rootFile = join(home, 'root.cjs');
  writeFileSync(childFile, "process.on('SIGTERM', () => {}); process.stdout.write('child-ready\\n'); setInterval(() => {}, 1000);");
  writeFileSync(rootFile, `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});spawn(process.execPath,[${JSON.stringify(childFile)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);`);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  let pgid, ready = false;
  try {
    const result = await supervise(process.execPath, [rootFile], {
      lifetimeMs: 700, graceMs: 100, pollMs: 20, handleSignals: false,
      onStart: ({ pid }) => { pgid = pid; }, onOutput: (_, data) => { if (data.toString().includes('child-ready')) ready = true; },
    });
    assert(ready); assert.equal(result.reason, 'deadline'); assert(result.disconnected);
    assert.equal(await groupIsRunning(pgid), false);
    assert(live(unrelated.pid), 'unrelated process must remain running');
  } finally {
    if (pgid) { try { process.kill(-pgid, 'SIGKILL'); } catch {} }
    unrelated.kill('SIGKILL'); rmSync(home, { recursive: true, force: true });
  }
});

test('cleanup continues after the immediate child exits with a live grandchild', { timeout: 12000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'agx-orphan-test-'));
  const rootFile = join(home, 'root.cjs');
  writeFileSync(rootFile, `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});c.stdout.once('data',()=>process.exit(0));`);
  let pgid;
  try {
    const result = await supervise(process.execPath, [rootFile], { lifetimeMs: 4000, graceMs: 100, pollMs: 20, handleSignals: false, onOutput: quiet, onStart: ({ pid }) => { pgid = pid; } });
    assert.equal(result.reason, 'receiver-exit'); assert.equal(result.code, 0);
    assert.equal(await groupIsRunning(pgid), false);
  } finally { if (pgid) { try { process.kill(-pgid, 'SIGKILL'); } catch {} } rmSync(home, { recursive: true, force: true }); }
});

test('SIGTERM of the supervisor cleans the group and exits', { timeout: 12000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'agx-interrupt-test-'));
  const pgidFile = join(home, 'pgid');
  const runner = join(home, 'runner.mjs');
  writeFileSync(runner, `import {supervise} from ${JSON.stringify(new URL('./supervise.mjs', import.meta.url).href)};import{writeFileSync}from'node:fs';const r=await supervise(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{graceMs:100,onStart:({pid})=>writeFileSync(${JSON.stringify(pgidFile)},String(pid))});console.log(JSON.stringify(r));`);
  const wrapper = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] });
  let pgid, output = '';
  wrapper.stdout.on('data', data => { output += data; });
  const exited = new Promise(resolve => wrapper.once('close', (code, signal) => resolve({ code, signal })));
  try {
    const until = Date.now() + 4000;
    while (!pgid && Date.now() < until) {
      try { pgid = Number(readFileSync(pgidFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!pgid) await delay(25);
    }
    assert(pgid); await delay(100); wrapper.kill('SIGTERM');
    const outcome = await exited;
    assert.equal(outcome.code, 0); assert.match(output, /"reason":"SIGTERM"/);
    assert.equal(await groupIsRunning(pgid), false);
  } finally { wrapper.kill('SIGKILL'); if (pgid) { try { process.kill(-pgid, 'SIGKILL'); } catch {} } rmSync(home, { recursive: true, force: true }); }
});

test('failed process inspection force-stops the group and does not claim verified cleanup', { timeout: 12000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'agx-inspection-test-'));
  const runner = join(home, 'runner.mjs');
  writeFileSync(join(home, 'ps'), '#!/bin/sh\nexit 42\n', { mode: 0o700 });
  writeFileSync(runner, `import{supervise}from ${JSON.stringify(new URL('./supervise.mjs', import.meta.url).href)};let pgid;try{await supervise(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{lifetimeMs:300,graceMs:100,onStart:({pid})=>{pgid=pid;}});process.exitCode=2;}catch{console.log(JSON.stringify({pgid,verified:false}));}`);
  const wrapper = spawn(process.execPath, [runner], { env: { ...process.env, PATH: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', pgid;
  wrapper.stdout.on('data', data => { output += data; });
  try {
    const code = await new Promise(resolve => wrapper.once('close', resolve));
    assert.equal(code, 0);
    const result = JSON.parse(output); pgid = result.pgid;
    assert(pgid); assert.equal(result.verified, false);
    const until = Date.now() + 3000;
    while (await groupIsRunning(pgid) && Date.now() < until) await delay(25);
    assert.equal(await groupIsRunning(pgid), false);
  } finally { wrapper.kill('SIGKILL'); if (pgid) { try { process.kill(-pgid, 'SIGKILL'); } catch {} } rmSync(home, { recursive: true, force: true }); }
});

for (const mode of ['callback','pipe','captured-pipe']) test(`output ${mode} failure cannot orphan the receiver group`, {timeout:12000},async()=>{
  const home=mkdtempSync(join(tmpdir(),'agx-output-review-')),pgidFile=join(home,'pgid'),runner=join(home,'runner.mjs');
  const outputOption=mode==='callback'?",onOutput:()=>{throw new Error('output sink failed');}":mode==='captured-pipe'?',onOutput:()=>{}':'';
  const parentOutput=mode==='captured-pipe'?"const timer=setInterval(()=>console.log('parent output'),20);":'const timer=undefined;';
  writeFileSync(runner,`import{supervise}from ${JSON.stringify(new URL('./supervise.mjs',import.meta.url).href)};import{writeFileSync}from'node:fs';${parentOutput}try{await supervise(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>console.log('test output'),20)"],{graceMs:100,onStart:({pid})=>writeFileSync(${JSON.stringify(pgidFile)},String(pid))${outputOption}});}catch{process.exitCode=3;}finally{clearInterval(timer);}`);
  const wrapper=spawn(process.execPath,[runner],{stdio:['ignore','pipe','pipe']});let pgid;
  let stderr='';wrapper.stderr.on('data',x=>{stderr+=x;});
  const done=new Promise(resolve=>wrapper.once('close',code=>resolve(code)));
  try{
    const until=Date.now()+4000;while(!pgid&&Date.now()<until){try{pgid=Number(readFileSync(pgidFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}if(!pgid)await delay(25);}
    assert(pgid);
    if(mode!=='callback')wrapper.stdout.destroy();else wrapper.stdout.resume();
    const code=await done;
    assert.equal(code,3,stderr);
    assert.equal(await groupIsRunning(pgid),false,'output failure must clean up the owned group');
  }finally{wrapper.kill('SIGKILL');if(pgid){try{process.kill(-pgid,'SIGKILL');}catch{}}rmSync(home,{recursive:true,force:true});}
});
