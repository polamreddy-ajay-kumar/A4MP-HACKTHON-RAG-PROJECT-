// RAG services: chunking, local embeddings, cosine similarity, answer generation
const STOP = new Set('a an and are as at be by for from has have how in is it of on or that the this to was what when which who will with can do does i my me you your we our not'.split(' '));

function tokens(text) {
  return (text.toLowerCase().match(/[a-z0-9%]+/g) || [])
    .filter(w => !STOP.has(w))
    .map(w => w.length > 4 ? w.slice(0, 4) : w);   // crude stem: first 4 letters
}

function chunkText(text, size = 800, overlap = 150) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size - overlap) {
    const piece = text.slice(i, i + size).trim();
    if (piece) chunks.push(piece);
  }
  return chunks;
}

// Local embedding: hashed bag-of-words (unigrams + bigrams) into 512 dimensions.
// Used when no external embedding API key is configured.
const DIM = 512;
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return Math.abs(h) % DIM; }
async function embedText(text) {
  const t = tokens(text), v = new Array(DIM).fill(0);
  t.forEach((w, i) => { v[hash(w)] += 1; if (i) v[hash(t[i - 1] + '_' + w)] += 0.5; });
  return v;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

async function retrieve(db, question, k = 4) {
  const qVec = await embedText(question);
  const rows = db.prepare(`SELECT c.id, c.content, c.embedding, d.title
    FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.status = 'INDEXED'`).all();
  return rows.map(r => ({ id: r.id, title: r.title, content: r.content,
      score: cosine(qVec, JSON.parse(r.embedding)) }))
    .sort((a, b) => b.score - a.score).slice(0, k);
}

// Answer generation. With LLM_API_KEY set, the Anthropic API is used (see report section 7.5).
// Without a key, the best-matching sentences of the retrieved chunks are returned (offline mode).
async function generateAnswer(question, contexts) {
  if (process.env.LLM_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.LLM_API_KEY });
    const context = contexts.map((c, i) => `[${i + 1}] (${c.title}) ${c.content}`).join('\n\n');
    const res = await client.messages.create({
      model: process.env.LLM_MODEL, max_tokens: 800,
      system: 'Answer only from the context. If the answer is not in the context, say you do not know. Cite sources like [1], [2].',
      messages: [{ role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` }]
    });
    return res.content[0].text;
  }
  const q = new Set(tokens(question)), scored = [];
  contexts.forEach((c, ci) => c.content.split(/(?<=[.!?])\s+|\n+/).forEach(s => {
    const w = tokens(s); const hit = w.filter(x => q.has(x)).length;
    if (hit && s.trim().length > 40) scored.push({ s: s.replace(/\s+/g, ' ').trim(), ci, score: hit / Math.sqrt(w.length + 1) });
  }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored.filter((x, i) => i === 0 || x.score >= 0.75 * scored[0].score).slice(0, 2);
  return best.map(b => `${b.s} [${b.ci + 1}]`).join(' ');
}

module.exports = { chunkText, embedText, cosine, retrieve, generateAnswer };
