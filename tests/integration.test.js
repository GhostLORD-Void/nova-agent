const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let child, baseUrl, tempDir;
async function waitForServer() {
  for (let i=0;i<80;i++) {
    if (child.exitCode !== null) throw new Error('server exited: '+child.exitCode);
    const m=child.stdoutText.match(/port ([0-9]+)/);
    if(m){baseUrl='http://127.0.0.1:'+m[1];try{const r=await fetch(baseUrl+'/api/health');if(r.ok)return}catch{}}
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('server did not start: '+child.stderrText+' | stdout: '+child.stdoutText);
}
let cookie='';
async function api(route,options={}) {
  const headers={'content-type':'application/json',...(cookie?{cookie}:{}),...(options.headers||{})};
  const r=await fetch(baseUrl+route,{...options,headers});
  const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];
  return {status:r.status,data:await r.json(),headers:r.headers};
}
test('NOVA API persists chat, specialist routing and memory in SQLite', async t => {
  tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-test-'));
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:'0',NOVA_DB_PATH:path.join(tempDir,'test.sqlite'),OLLAMA_HOST:'http://127.0.0.1:1',OLLAMA_MODEL:'qwen2.5:0.5b'},stdio:['ignore','pipe','pipe']});
  child.stdoutText='';child.stderrText='';
  child.stdout.on('data',d=>child.stdoutText+=d.toString());
  child.stderr.on('data',d=>child.stderrText+=d.toString());
  await waitForServer();
  const health=await api('/api/health');assert.equal(health.status,200);assert.equal(health.data.storage,'sqlite');assert.ok(health.data.agents.includes('coder'));
  const saved=await api('/api/memory',{method:'POST',body:JSON.stringify({content:'Project uses Node.js',category:'project'})});assert.equal(saved.status,201);assert.equal(saved.data.memory.content,'Project uses Node.js');
  const memories=await api('/api/memory');assert.equal(memories.data.memories.length,1);
  const chat=await api('/api/chat',{method:'POST',body:JSON.stringify({message:'Write a hello world function',agent:'coder'})});assert.equal(chat.status,200);assert.equal(chat.data.agent,'coder');assert.ok(chat.data.chatId);assert.match(chat.data.reply,/Demo fallback|Project uses Node.js|NOVA is ready|CodePilot is ready/);
  const loaded=await api('/api/chats/'+chat.data.chatId);assert.equal(loaded.status,200);assert.equal(loaded.data.chat.messages.length,2);assert.equal(loaded.data.chat.messages[0].role,'user');
  const dashboard=await api('/api/dashboard');assert.equal(dashboard.data.stats.totalChats,1);assert.equal(dashboard.data.stats.totalMessages,2);assert.equal(dashboard.data.stats.memories,1);
  const isolated=await fetch(baseUrl+'/api/dashboard');const isolatedData=await isolated.json();assert.equal(isolatedData.stats.totalChats,0);assert.equal(isolatedData.stats.memories,0);
  const outsiderCookie=(isolated.headers.get('set-cookie')||'').split(';')[0];const forbidden=await fetch(baseUrl+'/api/chats/'+chat.data.chatId,{headers:{cookie:outsiderCookie}});assert.equal(forbidden.status,404);
  const removed=await api('/api/memory/'+saved.data.memory.id,{method:'DELETE'});assert.equal(removed.status,200);
  const deleted=await api('/api/chats/'+chat.data.chatId,{method:'DELETE'});assert.equal(deleted.status,200);
  assert.equal((await api('/api/dashboard')).data.stats.totalChats,0);
});
after(()=>{if(child&&!child.killed)child.kill('SIGTERM');if(tempDir)fs.rmSync(tempDir,{recursive:true,force:true})});
