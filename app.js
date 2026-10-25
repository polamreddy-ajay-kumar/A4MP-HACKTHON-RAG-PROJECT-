// A4MP RAG SYSTEMS - client (vanilla JS single-page app)
const APP_NAME = 'A4MP RAG SYSTEMS';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let session = JSON.parse(localStorage.getItem('a4mp') || 'null');
let chatId = null, messages = [];

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (session) headers.Authorization = 'Bearer ' + session.token;
  if (opts.json) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
  const res = await fetch('/api' + path, { ...opts, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Request failed');
  return data;
}

function nav(active) {
  const admin = session.user.role === 'ADMIN';
  const link = (h, t) => `<a href="#/${h}" class="${active === h ? 'active' : ''}">${t}</a>`;
  return `<div class="nav"><div class="brand"><div class="mark">A4</div>${APP_NAME}</div>
    ${link('chat', 'Chat')}${link('history', 'History')}${admin ? link('documents', 'Documents') + link('admin', 'Dashboard') : ''}
    <div class="sp"></div><span class="chip">${esc(session.user.name)} (${session.user.role})</span>
    <button class="btn light" id="logout">Logout</button></div>`;
}

function loginPage() {
  $('#app').innerHTML = `<div class="wrap"><div class="hero"><h1>${APP_NAME}</h1><p>Artificial Intelligence Fourth Mind Platform &mdash; ask questions from your documents</p></div>
  <div class="cards">
    <div class="card"><h2>Login</h2><label>Email</label><input type="email" id="le" placeholder="you@example.com">
      <label>Password</label><input type="password" id="lp" placeholder="Password"><br><br><button class="btn" id="lb">Login</button><div class="msg-note" id="ln"></div></div>
    <div class="card"><h2>Register</h2><label>Name</label><input type="text" id="rn" placeholder="Full name">
      <label>Email</label><input type="email" id="re" placeholder="you@example.com"><label>Password</label><input type="password" id="rp" placeholder="At least 6 characters"><br><br>
      <button class="btn" id="rb">Create Account</button><div class="msg-note" id="rm"></div></div>
  </div><div class="foot">${APP_NAME} &copy; 2026</div></div>`;
  $('#lb').onclick = async () => {
    try { session = await api('/auth/login', { method: 'POST', json: { email: $('#le').value, password: $('#lp').value } });
      localStorage.setItem('a4mp', JSON.stringify(session)); location.hash = '#/chat'; render(); }
    catch (e) { $('#ln').textContent = e.message; }
  };
  $('#rb').onclick = async () => {
    try { const d = await api('/auth/register', { method: 'POST', json: { name: $('#rn').value, email: $('#re').value, password: $('#rp').value } });
      $('#rm').textContent = 'Registration successful. Please login, ' + d.name + '.'; }
    catch (e) { $('#rm').textContent = e.message; }
  };
}

function bubble(m) {
  const src = m.sources && m.sources.length ? `<div class="src">Sources: ${m.sources.map(s => esc(s.title) + ' (score ' + s.score + ')').join(', ')}</div>` : '';
  return `<div class="m ${m.role === 'user' ? 'user' : 'bot'}">${esc(m.text ?? m.content)}${src}</div>`;
}

function chatPage() {
  $('#app').innerHTML = nav('chat') + `<div class="wrap"><div class="chat"><div class="chat-head" style="display:flex;justify-content:space-between;align-items:center">${APP_NAME} &mdash; Ask your documents<button class="btn light" id="newchat" style="padding:6px 14px;font-size:13px">New Chat</button></div>
    <div class="chat-body" id="cb">${messages.length ? messages.map(bubble).join('') : '<div class="m bot">Hello! Ask me anything about the uploaded documents.</div>'}</div>
    <div class="chat-in"><input type="text" id="q" placeholder="Ask a question..."><button class="btn" id="ask">Ask</button></div></div></div>`;
  const send = async () => {
    const q = $('#q').value.trim(); if (!q) return;
    messages.push({ role: 'user', text: q }); $('#q').value = ''; chatPage();
    try { const d = await api('/chat/ask', { method: 'POST', json: { question: q, chatId } }); chatId = d.chatId || chatId;
      messages.push({ role: 'bot', text: d.answer, sources: d.sources }); }
    catch (e) { messages.push({ role: 'bot', text: e.message }); }
    chatPage(); const cb = $('#cb'); cb.scrollTop = cb.scrollHeight;
  };
  $('#newchat').onclick = () => { messages = []; chatId = null; chatPage(); };
  $('#ask').onclick = send; $('#q').onkeydown = e => { if (e.key === 'Enter') send(); };
}

async function historyPage(sel) {
  const { chats } = await api('/chat');
  const id = sel || (chats[0] && chats[0].id);
  const msgs = id ? (await api('/chat/' + id)).messages : [];
  $('#app').innerHTML = nav('history') + `<div class="wrap"><h2 class="pg">Chat History</h2><div class="split">
    <div class="list">${chats.map(c => `<div class="item ${c.id == id ? 'sel' : ''}" data-id="${c.id}">${esc(c.title)}<small>${esc(c.created_at)}</small></div>`).join('') || '<div class="item">No chats yet</div>'}</div>
    <div class="chat" style="height:auto;min-height:300px"><div class="chat-body">${msgs.map(bubble).join('')}</div></div></div></div>`;
  document.querySelectorAll('.item[data-id]').forEach(el => el.onclick = () => historyPage(el.dataset.id));
}

async function documentsPage() {
  const { documents } = await api('/documents');
  $('#app').innerHTML = nav('documents') + `<div class="wrap"><h2 class="pg">Document Management</h2>
    <div class="card" style="margin-bottom:22px"><div class="up"><div><label>Title</label><input type="text" id="dt" placeholder="Document title"></div>
    <div><label>Document (PDF or TXT)</label><input type="file" id="df" accept=".pdf,.txt"></div><button class="btn" id="du">Upload and Index</button></div><div class="msg-note" id="dm"></div></div>
    <table><tr><th>ID</th><th>Title</th><th>File</th><th>Status</th><th>Chunks</th><th>Uploaded by</th><th></th></tr>
    ${documents.map(d => `<tr><td>${d.id}</td><td>${esc(d.title)}</td><td>${esc(d.filename)}</td><td><span class="badge ${d.status}">${d.status}</span></td><td>${d.chunk_count}</td><td>${esc(d.uploaded_by)}</td><td><button class="btn danger" data-del="${d.id}">Delete</button></td></tr>`).join('')}</table></div>`;
  $('#du').onclick = async () => {
    const f = $('#df').files[0]; if (!f) { $('#dm').textContent = 'Please choose a file'; return; }
    const form = new FormData(); form.append('title', $('#dt').value); form.append('file', f);
    try { const d = await api('/documents', { method: 'POST', body: form }); $('#dm').textContent = 'Indexed ' + d.chunks + ' chunks'; setTimeout(documentsPage, 600); }
    catch (e) { $('#dm').textContent = e.message; }
  };
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('/documents/' + b.dataset.del, { method: 'DELETE' }); documentsPage(); });
}

async function adminPage() {
  const d = await api('/dashboard'); const { documents } = await api('/documents');
  $('#app').innerHTML = nav('admin') + `<div class="wrap"><h2 class="pg">${APP_NAME} &mdash; Admin Dashboard</h2><div class="stats">
    <div class="stat"><b>${d.documents}</b><span>Indexed Documents</span></div><div class="stat"><b>${d.chunks}</b><span>Total Chunks</span></div>
    <div class="stat"><b>${d.users}</b><span>Registered Users</span></div><div class="stat"><b>${d.questions}</b><span>Questions Asked</span></div></div>
    <h3 style="color:#12284c">Knowledge Base</h3><table><tr><th>ID</th><th>Title</th><th>Status</th><th>Chunks</th></tr>
    ${documents.map(x => `<tr><td>${x.id}</td><td>${esc(x.title)}</td><td><span class="badge ${x.status}">${x.status}</span></td><td>${x.chunk_count}</td></tr>`).join('')}</table></div>`;
}

function render() {
  const route = (location.hash.replace('#/', '') || 'chat');
  if (!session) return loginPage();
  const admin = session.user.role === 'ADMIN';
  if ((route === 'documents' || route === 'admin') && !admin) { location.hash = '#/chat'; return; }
  ({ chat: chatPage, history: historyPage, documents: documentsPage, admin: adminPage }[route] || chatPage)();
}
document.addEventListener('click', e => {
  if (e.target.id === 'logout') { localStorage.removeItem('a4mp'); session = null; messages = []; chatId = null; location.hash = ''; render(); }
});
window.addEventListener('hashchange', render);
render();
