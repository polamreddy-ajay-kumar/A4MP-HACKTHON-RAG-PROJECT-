// A4MP RAG SYSTEMS - server (Node.js + SQLite demo build)
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto'), { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { chunkText, embedText, retrieve, generateAnswer } = require('./rag');

const APP_NAME = 'A4MP RAG SYSTEMS';
const PORT = process.env.PORT || 5000;
const SECRET = process.env.JWT_SECRET || 'change-this-secret';
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, '..', 'a4mp_rag_db.sqlite'));
db.exec(`PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'USER');
CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, filename TEXT NOT NULL, uploaded_by INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'UPLOADED', chunk_count INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, embedding TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, sources TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);

// ---- password hashing and JWT (built-in crypto) ----
const hashPw = pw => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 32).toString('hex'); };
const checkPw = (pw, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(pw, s, 32)); };
const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const sign = (p, exp = 86400) => { const body = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ ...p, exp: Math.floor(Date.now() / 1000) + exp }); return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url'); };
const verify = t => { const [h, p, s] = (t || '').split('.'); if (!s || crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64url') !== s) throw new Error('bad'); const d = JSON.parse(Buffer.from(p, 'base64url')); if (d.exp < Date.now() / 1000) throw new Error('exp'); return d; };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function indexDocument(documentId, text) {
  try {
    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i++)
      db.prepare('INSERT INTO chunks (document_id, chunk_index, content, embedding) VALUES (?,?,?,?)').run(documentId, i, chunks[i], JSON.stringify(await embedText(chunks[i])));
    db.prepare("UPDATE documents SET status='INDEXED', chunk_count=? WHERE id=?").run(chunks.length, documentId);
    return chunks.length;
  } catch (e) { db.prepare("UPDATE documents SET status='FAILED' WHERE id=?").run(documentId); throw e; }
}

function parseMultipart(buf, ctype) {
  const boundary = '--' + ctype.split('boundary=')[1], out = { fields: {}, file: null };
  for (const part of buf.toString('latin1').split(boundary).slice(1, -1)) {
    const [head, ...rest] = part.split('\r\n\r\n'); const body = rest.join('\r\n\r\n').replace(/\r\n$/, '');
    const name = /name="([^"]+)"/.exec(head)[1], fn = /filename="([^"]*)"/.exec(head);
    if (fn) out.file = { name: fn[1], data: Buffer.from(body, 'latin1') }; else out.fields[name] = Buffer.from(body, 'latin1').toString('utf8');
  }
  return out;
}

const routes = [];
const route = (method, pattern, roles, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:id/, '(\\d+)') + '$'), roles, fn });

route('GET', '/api/health', null, () => ({ app: APP_NAME, status: 'running' }));

route('POST', '/api/auth/register', null, ({ body }) => {
  const { name, email, password } = body;
  if (!name || !name.trim()) throw new HttpError(400, 'Name is required');
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Valid email is required');
  if (!password || password.length < 6) throw new HttpError(400, 'Password needs 6+ characters');
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'User already exists');
  const r = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,'USER')").run(name.trim(), email, hashPw(password));
  return { _s: 201, data: { id: Number(r.lastInsertRowid), name: name.trim(), email, role: 'USER', status: 'Account Created' } };
});

route('POST', '/api/auth/login', null, ({ body }) => {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email || '');
  if (!user || !checkPw(body.password || '', user.password_hash)) throw new HttpError(401, 'Invalid credentials');
  return { token: sign({ id: user.id, role: user.role }), user: { id: user.id, name: user.name, role: user.role } };
});

route('GET', '/api/documents', ['ADMIN', 'USER'], () => ({ documents: db.prepare('SELECT d.id, d.title, d.filename, d.status, d.chunk_count, d.created_at, u.name AS uploaded_by FROM documents d JOIN users u ON u.id = d.uploaded_by ORDER BY d.id').all() }));

route('POST', '/api/documents', ['ADMIN'], async ({ raw, ctype, user }) => {
  const { fields, file } = parseMultipart(raw, ctype);
  if (!file) throw new HttpError(400, 'File is required');
  if (file.data.length > 10 * 1024 * 1024) throw new HttpError(400, 'File too large');
  const title = (fields.title || file.name).trim();
  let text;
  if (file.name.toLowerCase().endsWith('.pdf')) { const tmp = path.join(require('os').tmpdir(), 'up-' + Date.now() + '.pdf'); fs.writeFileSync(tmp, file.data); text = execFileSync('pdftotext', [tmp, '-']).toString(); fs.unlinkSync(tmp); }
  else text = file.data.toString('utf8');
  if (!text.trim()) throw new HttpError(400, 'No readable text found');
  const r = db.prepare('INSERT INTO documents (title, filename, uploaded_by) VALUES (?,?,?)').run(title, file.name, user.id);
  const id = Number(r.lastInsertRowid), chunks = await indexDocument(id, text);
  return { _s: 201, data: { id, title, chunks, status: 'INDEXED' } };
});

route('DELETE', '/api/documents/:id', ['ADMIN'], ({ params }) => {
  const r = db.prepare('DELETE FROM documents WHERE id = ?').run(params[0]);
  if (!r.changes) throw new HttpError(404, 'Document not found');
  return { message: 'Document deleted' };
});

route('POST', '/api/chat/ask', ['ADMIN', 'USER'], async ({ body, user }) => {
  const { question, chatId } = body;
  if (!question || question.trim().length < 3) throw new HttpError(400, 'Question is required');
  const contexts = await retrieve(db, question.trim(), 4);
  if (!contexts.length || contexts[0].score < 0.2) return { answer: 'I could not find this in the documents.', sources: [] };
  const answer = await generateAnswer(question.trim(), contexts);
  const sources = contexts.filter(c => c.score >= 0.2).map(c => ({ title: c.title, score: Number(c.score.toFixed(2)) }));
  let id = chatId;
  if (id) { if (!db.prepare('SELECT id FROM chats WHERE id = ? AND user_id = ?').get(id, user.id)) throw new HttpError(404, 'Chat not found'); }
  else id = Number(db.prepare('INSERT INTO chats (user_id, title) VALUES (?, ?)').run(user.id, question.slice(0, 60)).lastInsertRowid);
  db.prepare("INSERT INTO messages (chat_id, role, content) VALUES (?, 'user', ?)").run(id, question);
  db.prepare("INSERT INTO messages (chat_id, role, content, sources) VALUES (?, 'assistant', ?, ?)").run(id, answer, JSON.stringify(sources));
  return { chatId: id, answer, sources };
});

route('GET', '/api/chat', ['ADMIN', 'USER'], ({ user }) => ({ chats: db.prepare('SELECT id, title, created_at FROM chats WHERE user_id = ? ORDER BY id DESC').all(user.id) }));

route('GET', '/api/chat/:id', ['ADMIN', 'USER'], ({ params, user }) => {
  if (!db.prepare('SELECT id FROM chats WHERE id = ? AND user_id = ?').get(params[0], user.id)) throw new HttpError(404, 'Chat not found');
  return { messages: db.prepare('SELECT role, content, sources, created_at FROM messages WHERE chat_id = ? ORDER BY id').all(params[0]).map(m => ({ ...m, sources: m.sources ? JSON.parse(m.sources) : [] })) };
});

route('GET', '/api/dashboard', ['ADMIN'], () => {
  const d = db.prepare("SELECT COUNT(*) total, COALESCE(SUM(chunk_count),0) chunks FROM documents WHERE status = 'INDEXED'").get();
  return { documents: d.total, chunks: Number(d.chunks), users: db.prepare('SELECT COUNT(*) total FROM users').get().total, questions: db.prepare("SELECT COUNT(*) total FROM messages WHERE role = 'user'").get().total };
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    if (!url.pathname.startsWith('/api/')) {
      const f = path.join(__dirname, '..', 'client', 'public', url.pathname === '/' ? 'index.html' : url.pathname);
      if (!f.includes('public') || !fs.existsSync(f)) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); return res.end(fs.readFileSync(f));
    }
    const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'Not found');
    let user = null;
    if (r.roles) {
      try { user = verify((req.headers.authorization || '').replace('Bearer ', '')); } catch { throw new HttpError(401, 'Invalid or missing token'); }
      if (!r.roles.includes(user.role)) throw new HttpError(403, 'Access denied');
    }
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks), ctype = req.headers['content-type'] || '';
    const body = ctype.includes('json') && raw.length ? JSON.parse(raw) : {};
    const out = await r.fn({ body, raw, ctype, user, params: r.re.exec(url.pathname).slice(1) });
    out && out._s ? send(out._s, out.data) : send(200, out);
  } catch (e) { if (!(e instanceof HttpError)) console.error(e.message); send(e.status || 500, { message: e.message || 'Server error' }); }
}).listen(PORT, () => {
  console.log('==================================================');
  console.log('  ' + APP_NAME);
  console.log('  Server running on port ' + PORT);
  console.log('==================================================');
});

// first-run admin account
if (!db.prepare("SELECT id FROM users WHERE role='ADMIN'").get())
  db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('Admin','admin@a4mp.com',?,'ADMIN')").run(hashPw('Admin@123'));
