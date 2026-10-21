const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.NOVA_DB_PATH || path.join(ROOT, 'data', 'nova.sqlite');
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, last_seen TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'nova',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT 'local'
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')), agent TEXT NOT NULL,
    content TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general', created_at TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT 'local'
  );
`);
// Migrate existing local databases without dropping user data.
for (const [table,column] of [['conversations','session_id'],['memories','session_id']]) {
  if (!db.prepare('PRAGMA table_info('+table+')').all().some(c=>c.name===column)) db.exec('ALTER TABLE '+table+' ADD COLUMN '+column+" TEXT NOT NULL DEFAULT 'local'");
}
db.exec('PRAGMA foreign_keys = ON');
const mime = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json' };
const agents = {
  nova: { name:'NOVA', role:'General assistant', prompt:'You are NOVA, a helpful, clear, practical AI assistant. Explain uncertainty and do not invent facts.' },
  researcher: { name:'Researcher', role:'Research & analysis', prompt:'You are NOVA Researcher. Break questions into claims, distinguish known facts from uncertainty, compare options, and never fabricate sources or pretend you browsed the web.' },
  coder: { name:'CodePilot', role:'Coding & debugging', prompt:'You are NOVA CodePilot, a senior software engineer. Give correct, secure, maintainable code, explain assumptions, and include tests or commands when useful.' },
  writer: { name:'Wordsmith', role:'Writing & editing', prompt:'You are NOVA Wordsmith. Produce polished, audience-aware writing. Follow the requested format and tone; avoid unnecessary preambles.' },
  planner: { name:'Strategist', role:'Planning & execution', prompt:'You are NOVA Strategist. Convert goals into prioritized, realistic steps, dependencies, risks, and measurable outcomes.' }
};
const now = () => new Date().toISOString();
const id = () => require('node:crypto').randomUUID();
function json(res, status, data) { res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}); res.end(JSON.stringify(data)); }
function readBody(req) {
  return new Promise((resolve,reject) => { let raw=''; req.on('data', chunk => { raw += chunk; if(raw.length > 1_000_000){ reject(new Error('Request too large')); req.destroy(); }}); req.on('end',()=>{try{resolve(JSON.parse(raw||'{}'))}catch{reject(new Error('Invalid JSON'))}}); req.on('error',reject); });
}
function rows(sql, ...args) { return db.prepare(sql).all(...args); }
function getConversation(cid, sid) { return db.prepare('SELECT * FROM conversations WHERE id=? AND session_id=?').get(cid,sid); }
function sessionFor(req,res) {
  const raw=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('nova_sid='));
  const candidate=raw?raw.slice('nova_sid='.length):'';
  if(candidate && /^[A-Za-z0-9_-]{40,60}$/.test(candidate) && db.prepare('SELECT id FROM sessions WHERE id=?').get(candidate)) {
    db.prepare('UPDATE sessions SET last_seen=? WHERE id=?').run(now(),candidate); return candidate;
  }
  const sid=require('node:crypto').randomBytes(32).toString('base64url'); const t=now();
  db.prepare('INSERT INTO sessions(id,created_at,last_seen) VALUES(?,?,?)').run(sid,t,t);
  const secure=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https'?' Secure;':'';
  res.setHeader('set-cookie','nova_sid='+sid+'; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000;'+secure); return sid;
}
function demoReply(message, agent) {
  const label = agents[agent]?.name || 'NOVA';
  return label + ' is ready. Your message was saved to this conversation. To get a generated answer, start Ollama with a downloaded model on this device. Demo mode does not call a language model.\n\nYour prompt: ' + message.slice(0, 500);
}
async function handleApi(req,res,url) {
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res,200,{ok:true,model:MODEL,ollamaHostConfigured:!!OLLAMA_HOST,storage:'sqlite',agents:Object.keys(agents)});
  const sid=sessionFor(req,res);
  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    const totalMessages = db.prepare('SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.session_id=?').get(sid).n;
    const totalChats = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE session_id=?').get(sid).n;
    const memories = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE session_id=?').get(sid).n;
    const recent = rows('SELECT id,title,agent,created_at,updated_at FROM conversations WHERE session_id=? ORDER BY updated_at DESC LIMIT 6',sid);
    return json(res,200,{stats:{totalMessages,totalChats,memories,agents:Object.keys(agents).length},recent,agents});
  }
  if (req.method === 'GET' && url.pathname === '/api/chats') return json(res,200,{chats:rows('SELECT id,title,agent,created_at,updated_at FROM conversations WHERE session_id=? ORDER BY updated_at DESC LIMIT 100',sid)});
  if (req.method === 'POST' && url.pathname === '/api/chats') {
    const b=await readBody(req); const cid=id(); const title=String(b.title||'New conversation').trim().slice(0,100)||'New conversation'; const agent=agents[b.agent]?b.agent:'nova'; const t=now();
    db.prepare('INSERT INTO conversations(id,title,agent,created_at,updated_at,session_id) VALUES(?,?,?,?,?,?)').run(cid,title,agent,t,t,sid);
    return json(res,201,{chat:{id:cid,title,agent,created_at:t,updated_at:t,messages:[]}});
  }
  const chatMatch=url.pathname.match(/^\/api\/chats\/([\w-]+)$/);
  if (req.method === 'GET' && chatMatch) {
    const chat=getConversation(chatMatch[1],sid); if(!chat)return json(res,404,{error:'Conversation not found'});
    return json(res,200,{chat:{...chat,messages:rows('SELECT id,role,agent,content,created_at FROM messages WHERE conversation_id=? ORDER BY id',chat.id)}});
  }
  if (req.method === 'DELETE' && chatMatch) {
    db.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE id=? AND session_id=?)').run(chatMatch[1],sid);
    const result=db.prepare('DELETE FROM conversations WHERE id=? AND session_id=?').run(chatMatch[1],sid);
    return json(res,result.changes?200:404,{ok:!!result.changes});
  }
  if (req.method === 'GET' && url.pathname === '/api/memory') return json(res,200,{memories:rows('SELECT id,content,category,created_at FROM memories WHERE session_id=? ORDER BY id DESC LIMIT 200',sid)});
  if (req.method === 'POST' && url.pathname === '/api/memory') {
    const b=await readBody(req); const content=String(b.content||'').trim().slice(0,2000); if(!content)return json(res,400,{error:'Memory content is required'});
    const category=String(b.category||'general').slice(0,40); const t=now(); const result=db.prepare('INSERT INTO memories(content,category,created_at,session_id) VALUES(?,?,?,?)').run(content,category,t,sid);
    return json(res,201,{memory:{id:Number(result.lastInsertRowid),content,category,created_at:t}});
  }
  const memoryMatch=url.pathname.match(/^\/api\/memory\/(\d+)$/);
  if(req.method==='DELETE' && memoryMatch){const r=db.prepare('DELETE FROM memories WHERE id=? AND session_id=?').run(Number(memoryMatch[1]),sid);return json(res,r.changes?200:404,{ok:!!r.changes});}
  if(req.method === 'POST' && url.pathname === '/api/chat') {
    const b=await readBody(req); const message=String(b.message||'').trim(); if(!message)return json(res,400,{error:'Message is required'}); if(message.length>12000)return json(res,413,{error:'Message is too long (12,000 characters max)'});
    const agent=agents[b.agent]?b.agent:'nova'; let cid=String(b.chatId||''); let chat=cid?getConversation(cid,sid):null;
    if(!chat){cid=id();const t=now();const title=message.replace(/\s+/g,' ').slice(0,56)+(message.length>56?'…':'');db.prepare('INSERT INTO conversations(id,title,agent,created_at,updated_at,session_id) VALUES(?,?,?,?,?,?)').run(cid,title,agent,t,t,sid);}
    const t=now(); db.prepare('INSERT INTO messages(conversation_id,role,agent,content,created_at) VALUES(?,?,?,?,?)').run(cid,'user',agent,message,t);
    const memory=rows('SELECT content FROM memories WHERE session_id=? ORDER BY id DESC LIMIT 12',sid).map(x=>x.content);
    const history=rows('SELECT role,content FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 16',cid).reverse();
    let reply, mode='demo';
    try {
      const response=await fetch(OLLAMA_HOST+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:MODEL,stream:false,messages:[{role:'system',content:agents[agent].prompt+(memory.length?'\n\nUser workspace memory (use only when relevant):\n- '+memory.join('\n- '):'')},...history.map(m=>({role:m.role,content:m.content}))]}),signal:AbortSignal.timeout(120000)});
      const data=await response.json(); if(!response.ok)throw new Error(data.error||'Ollama request failed'); reply=data.message?.content?.trim(); if(!reply)throw new Error('Model returned an empty response'); mode='ollama';
    } catch(e) { reply=demoReply(message,agent); mode='demo'; }
    const savedAt=now(); db.prepare('INSERT INTO messages(conversation_id,role,agent,content,created_at) VALUES(?,?,?,?,?)').run(cid,'assistant',agent,reply,savedAt);
    db.prepare('UPDATE conversations SET updated_at=?,agent=? WHERE id=?').run(savedAt,agent,cid);
    return json(res,200,{reply,mode,agent,chatId:cid,model:mode==='ollama'?MODEL:null});
  }
  return json(res,404,{error:'API route not found'});
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')) { try{return await handleApi(req,res,url)}catch(e){console.error('API error:',e.message);return json(res,500,{error:'Internal server error'})} }
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{'allow':'GET, HEAD'});return res.end('Method not allowed')}
  let pathname;try{pathname=decodeURIComponent(url.pathname)}catch{return json(res,400,{error:'Bad path'})}
  const requested=pathname==='/'?'index.html':pathname.replace(/^\/+/, '');
  const file=path.resolve(ROOT,requested);if(file!==ROOT&&!file.startsWith(ROOT+path.sep)){res.writeHead(403);return res.end('Forbidden')}
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found')}res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin','x-frame-options':'DENY'});res.end(data)});
});
server.listen(PORT,'0.0.0.0',()=>console.log('NOVA platform running on port '+server.address().port+' | SQLite: '+DB_PATH+' | model: '+MODEL));
process.on('SIGINT',()=>{db.close();server.close(()=>process.exit(0))});
process.on('SIGTERM',()=>{db.close();server.close(()=>process.exit(0))});
