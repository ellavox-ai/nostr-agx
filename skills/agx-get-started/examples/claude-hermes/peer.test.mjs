import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { nip19 } from 'nostr-tools';
import { groupIsRunning } from './supervise.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const requester = nip19.npubEncode('11'.repeat(32)), receiver = nip19.npubEncode('22'.repeat(32));
const active = new Set();
function fixture({ hangRequest = false } = {}) {
  const kit = mkdtempSync(join(tmpdir(), 'agx-peer-review-'));
  mkdirSync(join(kit, 'node_modules/@nostr-agx/cli/dist'), { recursive: true });
  for (const name of ['peer.mjs','request-plan.mjs','supervise.mjs','hermes-handler.mjs','receiver-lock.mjs']) {
    if (existsSync(join(dir,name))) copyFileSync(join(dir,name),join(kit,name));
  }
  writeFileSync(join(kit,'package.json'), '{"type":"module"}');
  symlinkSync(join(dir,'node_modules/nostr-tools'),join(kit,'node_modules/nostr-tools'),'dir');
  const home=join(kit,'.agx-test'); mkdirSync(join(home,'profiles/receiver'),{recursive:true});
  const fake = `import fs from 'node:fs';import path from 'node:path';const a=process.argv.slice(2),h=process.env.AGX_HOME;
if(a.includes('identity')&&a.includes('show'))console.log(JSON.stringify({npub:a.includes('receiver')?${JSON.stringify(receiver)}:${JSON.stringify(requester)}}));
else if(a.includes('identity')&&a.includes('--list'))console.log(JSON.stringify({allow:[${JSON.stringify(requester)}]}));
else if(a.includes('serve')){const lock=path.join(h,'profiles/receiver/serve.lock');if(fs.existsSync(lock)){console.error('already serving');process.exit(1);}fs.writeFileSync(lock,String(process.pid));console.log('watching for messages');process.on('SIGTERM',()=>{fs.rmSync(lock,{force:true});process.exit(0);});setInterval(()=>{},1000);}
else if(a.includes('request')){if(${hangRequest}){fs.writeFileSync(path.join(h,'request-pid'),String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}else{const payload=JSON.parse(a[a.indexOf('--payload')+1]);fs.writeFileSync(path.join(h,'published.json'),JSON.stringify({payload,to:a[a.indexOf('--')+1]}));console.log(JSON.stringify({ok:true,result:{runtime:'hermes-cli',nonce:payload.nonce,summary:'Synthetic summary. '+payload.nonce}}));}}
else process.exit(0);`;
  writeFileSync(join(kit,'node_modules/@nostr-agx/cli/dist/agx.js'),fake);
  return kit;
}
function start(kit,args) {
  const child=spawn(process.execPath,[join(kit,'peer.mjs'),...args],{cwd:kit,stdio:['ignore','pipe','pipe']});
  active.add(child);
  const s={child,stdout:'',stderr:'',closed:false};
  child.stdout.on('data',x=>{s.stdout+=x;});child.stderr.on('data',x=>{s.stderr+=x;});
  s.done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{s.closed=true;active.delete(child);resolve({...s,code});});});
  return s;
}
async function waitFor(fn,description) {
  const end=Date.now()+5000;while(!fn()&&Date.now()<end)await delay(25);assert(fn(),description);
}
async function stop(s,pgid) {
  s?.child.kill('SIGTERM');
  const until=Date.now()+4000;while(s&&!s.closed&&Date.now()<until)await delay(25);
  if(pgid){try{process.kill(-pgid,'SIGKILL');}catch{}}
  if(s&&!s.closed)s.child.kill('SIGKILL');
  if(s)await s.done;
}

test('a second wrapper cannot replace a running receiver status', {timeout:15000}, async()=>{
  const kit=fixture();let first,pgid;
  try{
    first=start(kit,['serve',requester]);await waitFor(()=>first.stdout.includes('watching for messages'),'first receiver ready');
    const statusPath=join(kit,'.agx-test/receiver-status.json');const original=readFileSync(statusPath,'utf8');pgid=JSON.parse(original).pgid;
    const second=await start(kit,['serve',requester]).done;
    assert.notEqual(second.code,0);
    assert.equal(readFileSync(statusPath,'utf8'),original,'second launch must not overwrite active status');
    assert(await groupIsRunning(pgid));
    await stop(first,pgid);
    assert(!existsSync(join(kit,'.agx-test/receiver-wrapper.lock')),'clean shutdown releases its own wrapper lock');
  }finally{await stop(first,pgid);rmSync(kit,{recursive:true,force:true});}
});

test('an existing CLI serve lock blocks startup before status is replaced', {timeout:15000},async()=>{
  const kit=fixture();
  try{
    const status=join(kit,'.agx-test/receiver-status.json');writeFileSync(status,'prior test status');
    writeFileSync(join(kit,'.agx-test/profiles/receiver/serve.lock'),'prior lock');
    assert.notEqual((await start(kit,['serve',requester]).done).code,0);
    assert.equal(readFileSync(status,'utf8'),'prior test status');
    assert(!existsSync(join(kit,'.agx-test/receiver-wrapper.lock')));
  }finally{rmSync(kit,{recursive:true,force:true});}
});

test('interrupting a direct sender stops its CLI group and keeps the attempted nonce consumed', {timeout:15000},async()=>{
  const kit=fixture({hangRequest:true});let sender,pgid;
  try{
    assert.equal((await start(kit,['prepare',receiver]).done).code,0);
    const plan=JSON.parse(readFileSync(join(kit,'request-plan.json'),'utf8'));
    const digest=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    sender=start(kit,['send',digest]);
    const path=join(kit,'.agx-test/request-pid');await waitFor(()=>existsSync(path),'sender CLI started');pgid=Number(readFileSync(path,'utf8'));
    sender.child.kill('SIGTERM');const result=await sender.done;
    assert.notEqual(result.code,0);assert.match(result.stderr,/SIGTERM/);
    assert.equal(await groupIsRunning(pgid),false);
    assert(existsSync(join(kit,'.agx-test/request-attempts',plan.payload.nonce)));
  }finally{await stop(sender,pgid);rmSync(kit,{recursive:true,force:true});}
});

test('send requires a reviewed digest and rejects a changed destination before publication', {timeout:15000},async()=>{
  const kit=fixture();
  try{
    assert.equal((await start(kit,['prepare',receiver]).done).code,0);
    const planPath=join(kit,'request-plan.json'),plan=JSON.parse(readFileSync(planPath,'utf8'));
    const digest=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    const missing=await start(kit,['send']).done;
    assert.notEqual(missing.code,0,'unbound send must be refused');
    assert(!existsSync(join(kit,'.agx-test/published.json')));
    writeFileSync(planPath,JSON.stringify({...plan,to:requester}));
    assert.notEqual((await start(kit,['send',digest]).done).code,0);
    assert(!existsSync(join(kit,'.agx-test/published.json')),'changed reviewed task must not publish');
    writeFileSync(planPath,JSON.stringify(plan));
    const sent=await start(kit,['send',digest]).done;
    assert.equal(sent.code,0,sent.stderr);assert.match(sent.stdout,/"verified": true/);
    assert.equal(JSON.parse(readFileSync(join(kit,'.agx-test/published.json'),'utf8')).to,receiver);
    assert.notEqual((await start(kit,['send',digest]).done).code,0,'same plan cannot be sent twice');
  }finally{rmSync(kit,{recursive:true,force:true});}
});
