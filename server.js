// Serves the app and a small stats API. The app itself is a static page and
// stays fully usable without this server — every API call from the browser is
// best-effort, so opening index.html from a file server still works, just
// without tracking.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// Railway injects DATABASE_URL. Without it the server still serves the page and
// reports tracking as unavailable rather than failing every request.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      // Railway's managed Postgres presents a certificate the default CA bundle
      // doesn't cover; the connection is still encrypted.
      ssl: /\blocalhost\b|127\.0\.0\.1/.test(process.env.DATABASE_URL)
        ? false
        : { rejectUnauthorized: false },
      max: 5,
    })
  : null;

let dbReady = false;

async function initDb() {
  if (!pool) {
    console.log('DATABASE_URL not set — running without stats tracking');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           BIGSERIAL PRIMARY KEY,
      username     TEXT NOT NULL,
      -- Names are matched case-insensitively, so "Grace" and "grace" are the
      -- same person rather than two accounts nobody can tell apart.
      username_key TEXT NOT NULL UNIQUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attempts (
      id         BIGSERIAL PRIMARY KEY,
      user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      -- The calendar day as the singer experienced it. Streaks are a local-time
      -- idea: deriving the day from a UTC timestamp would end someone's streak
      -- at 5pm or hand them a free day, depending on their offset.
      day        DATE NOT NULL,
      correct    BOOLEAN NOT NULL,
      skipped    BOOLEAN NOT NULL,
      exercise   TEXT,
      prompt     TEXT,
      base_midi  INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS attempts_user_day_idx ON attempts (user_id, day);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS melodies (
      id         BIGSERIAL PRIMARY KEY,
      user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
      -- Kept alongside user_id so a melody still says who added it after that
      -- person's row goes away.
      added_by   TEXT,
      song       TEXT NOT NULL,
      artist     TEXT NOT NULL,
      part       TEXT NOT NULL,
      -- The whole take in one document: notes, words, key, chords, harmony.
      -- It is only ever read back as a unit, and its shape is the client's to
      -- evolve, so columns per field would buy nothing.
      take       JSONB NOT NULL,
      source     TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS melodies_recent_idx ON melodies (created_at DESC);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uploads (
      id         BIGSERIAL PRIMARY KEY,
      user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
      added_by   TEXT,
      title      TEXT NOT NULL,
      -- Which part was pulled out; the other column is everything else.
      stem       TEXT NOT NULL,
      -- LALAL.AI drops its copies within a day, so the audio has to live
      -- somewhere of ours. A stem is a few megabytes and there is no object
      -- store in this deployment, so it sits beside everything else the app
      -- owns rather than adding a second service to keep in sync.
      stem_audio BYTEA NOT NULL,
      back_audio BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS uploads_recent_idx ON uploads (created_at DESC);`);
  dbReady = true;
  console.log('stats tracking ready');
}

// node-postgres returns BIGSERIAL as a string to protect precision beyond
// 2^53. These ids will never get near that, and the browser stores the id as
// JSON and checks it is a number, so hand back a real number.
const asUser = (row) => ({ id: Number(row.id), username: row.username });

// ---- helpers ----
function send(res, code, body, headers) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e5) req.destroy();   // nothing this API takes is large
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// The parts of a song a melody can belong to. Kept closed so the library can
// be grouped and filtered rather than accumulating spellings of "chorus".
const PARTS = ['verse', 'pre-chorus', 'chorus', 'bridge', 'intro', 'outro', 'hook', 'other'];

const cleanText = (v, max) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);

// ---- stem splitting (LALAL.AI) ----
// The key never reaches the browser: every call to LALAL.AI goes out from here,
// and the finished stems are streamed back through this server so the page only
// ever talks to its own origin.
const LALAL = 'https://www.lalal.ai/api/v1';
const LALAL_KEY = process.env.LALALAI_LICENSE_KEY || '';
const UPLOAD_LIMIT = 30 * 1024 * 1024;   // a few minutes of mp3, well under LALAL.AI's own limit
const STEMS = ['vocals', 'drum', 'piano', 'bass', 'guitar'];
const STORE_LIMIT = 25 * 1024 * 1024;    // per stem, once the library keeps it

function readBinary(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function lalal(path, options) {
  const r = await fetch(LALAL + path, Object.assign({}, options, {
    headers: Object.assign({ 'X-License-Key': LALAL_KEY }, (options || {}).headers),
  }));
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = { detail: text.slice(0, 200) }; }
  if (!r.ok) throw Object.assign(new Error(body.detail || body.error || 'split service error'), { status: r.status });
  return body;
}

// Where a finished task's audio actually lives. The URL is short-lived and
// belongs to LALAL.AI, so it is resolved here every time and never handed out.
async function lalalTrack(taskId, wanted) {
  const body = await lalal('/check/', {
    method: 'POST',
    body: JSON.stringify({ task_ids: [taskId] }),
    headers: { 'Content-Type': 'application/json' },
  });
  const result = body.result && body.result[taskId];
  if (!result || result.status !== 'success') return null;
  return (result.result.tracks || []).find((t) => t.type === wanted) || null;
}

async function handleStems(req, res, url) {
  if (!LALAL_KEY) return send(res, 503, { error: 'splitting unavailable' });

  // What the page asks on load, to decide whether to show the door at all.
  if (url.pathname === '/api/stems' && req.method === 'GET') {
    const { minutes_left: minutesLeft } = await lalal('/limits/minutes_left/', { method: 'POST' });
    return send(res, 200, { enabled: true, minutesLeft });
  }

  if (url.pathname === '/api/stems/split' && req.method === 'POST') {
    const stem = STEMS.includes(url.searchParams.get('stem')) ? url.searchParams.get('stem') : 'vocals';
    let audio;
    try {
      audio = await readBinary(req, UPLOAD_LIMIT);
    } catch (e) {
      return send(res, 413, { error: 'That file is larger than 30 MB — trim it or export a smaller one.' });
    }
    if (!audio.length) return send(res, 400, { error: 'No audio in the request.' });
    // A name is required, and its extension is how LALAL.AI reads the format.
    const name = (url.searchParams.get('name') || 'track.mp3').replace(/[^\w.\- ]/g, '_').slice(0, 80);
    const uploaded = await lalal('/upload/', {
      method: 'POST',
      body: audio,
      headers: {
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Type': 'application/octet-stream',
      },
    });
    const task = await lalal('/split/stem_separator/', {
      method: 'POST',
      body: JSON.stringify({ source_id: uploaded.id, presets: { stem } }),
      headers: { 'Content-Type': 'application/json' },
    });
    return send(res, 200, { taskId: task.task_id, stem, duration: uploaded.duration });
  }

  // Splitting takes a while, so the page polls this and shows the progress.
  if (url.pathname === '/api/stems/check' && req.method === 'GET') {
    const taskId = url.searchParams.get('task') || '';
    const body = await lalal('/check/', {
      method: 'POST',
      body: JSON.stringify({ task_ids: [taskId] }),
      headers: { 'Content-Type': 'application/json' },
    });
    const result = body.result && body.result[taskId];
    if (!result) return send(res, 404, { error: 'not found' });
    if (result.status === 'success') {
      // Hand back labels only: the download URLs stay on this side, so the
      // browser fetches the audio from /api/stems/track and the split service
      // is never addressed from the page.
      return send(res, 200, {
        status: 'success',
        tracks: (result.result.tracks || []).map((t) => ({ type: t.type, label: t.label })),
      });
    }
    if (result.status === 'progress') {
      return send(res, 200, { status: 'progress', progress: result.progress || 0 });
    }
    return send(res, 200, { status: result.status, error: result.error || null });
  }

  if (url.pathname === '/api/stems/track' && req.method === 'GET') {
    const taskId = url.searchParams.get('task') || '';
    const wanted = url.searchParams.get('type') === 'back' ? 'back' : 'stem';
    const track = await lalalTrack(taskId, wanted);
    if (!track) return send(res, 404, { error: 'not ready' });
    const audio = await fetch(track.url);
    if (!audio.ok) return send(res, 502, { error: 'could not fetch the split track' });
    res.writeHead(200, {
      'Content-Type': audio.headers.get('content-type') || 'audio/mpeg',
      'Content-Disposition': `attachment; filename="${track.label}.mp3"`,
      'Cache-Control': 'no-store',
    });
    const reader = audio.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  }

  return send(res, 404, { error: 'not found' });
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (s) => typeof s === 'string' && DAY_RE.test(s) && !isNaN(Date.parse(s));

function dayKey(value) {
  // node-postgres hands DATE back as a Date in local time; format it by its own
  // parts so the day never shifts by a timezone on the way out.
  if (value instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

// Consecutive days ending today, or ending yesterday when today hasn't been
// practised yet — otherwise a streak would appear broken every morning until
// the first attempt of the day.
function streakFrom(days, today) {
  const done = new Set(days.filter((d) => d.total > 0).map((d) => d.day));
  const at = (offset) => {
    const d = new Date(today + 'T00:00:00');
    d.setDate(d.getDate() - offset);
    return dayKey(d);
  };
  let start = done.has(at(0)) ? 0 : done.has(at(1)) ? 1 : -1;
  if (start < 0) return 0;
  let streak = 0;
  for (let i = start; done.has(at(i)); i++) streak++;
  return streak;
}

function bestStreakFrom(days) {
  const sorted = days.filter((d) => d.total > 0).map((d) => d.day).sort();
  let best = 0, run = 0, prev = null;
  for (const day of sorted) {
    if (prev) {
      const gap = (Date.parse(day + 'T00:00:00Z') - Date.parse(prev + 'T00:00:00Z')) / 86400000;
      run = gap === 1 ? run + 1 : 1;
    } else {
      run = 1;
    }
    best = Math.max(best, run);
    prev = day;
  }
  return best;
}

// ---- API ----
async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') {
    return send(res, 200, { ok: true, tracking: dbReady, splitting: Boolean(LALAL_KEY) });
  }
  // Splitting stands on its own — it needs no database, so it comes before the
  // check that turns the rest of the API off.
  if (url.pathname === '/api/stems' || url.pathname.startsWith('/api/stems/')) {
    return handleStems(req, res, url);
  }
  if (!dbReady) return send(res, 503, { error: 'tracking unavailable' });

  // Claim a username, or pick up the one already tracking under that name.
  if (url.pathname === '/api/user' && req.method === 'POST') {
    const body = await readJson(req);
    const username = String(body.username || '').trim().replace(/\s+/g, ' ');
    if (username.length < 2 || username.length > 24) {
      return send(res, 400, { error: 'Pick a name between 2 and 24 characters.' });
    }
    if (!/^[\w .'-]+$/u.test(username)) {
      return send(res, 400, { error: 'Letters, numbers, spaces, . - _ and ’ only.' });
    }
    const key = username.toLowerCase();
    // One row per name: the insert loses the race deliberately and the select
    // that follows returns whoever holds it, so two people racing the same name
    // end up on the same row rather than creating a duplicate.
    const ins = await pool.query(
      `INSERT INTO users (username, username_key) VALUES ($1, $2)
       ON CONFLICT (username_key) DO NOTHING
       RETURNING id, username`,
      [username, key]
    );
    if (ins.rows.length) return send(res, 200, { user: asUser(ins.rows[0]), created: true });
    const found = await pool.query(`SELECT id, username FROM users WHERE username_key = $1`, [key]);
    if (!found.rows.length) return send(res, 500, { error: 'could not claim that name' });
    return send(res, 200, { user: asUser(found.rows[0]), created: false });
  }

  if (url.pathname === '/api/attempt' && req.method === 'POST') {
    const body = await readJson(req);
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) return send(res, 400, { error: 'bad userId' });
    if (!isDay(body.day)) return send(res, 400, { error: 'bad day' });
    const skipped = !!body.skipped;
    const correct = !skipped && !!body.correct;   // a skip is never a right answer
    try {
      await pool.query(
        `INSERT INTO attempts (user_id, day, correct, skipped, exercise, prompt, base_midi)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, body.day, correct, skipped,
         body.exercise ? String(body.exercise).slice(0, 32) : null,
         body.prompt ? String(body.prompt).slice(0, 64) : null,
         Number.isInteger(body.baseMidi) ? body.baseMidi : null]
      );
    } catch (e) {
      if (e.code === '23503') return send(res, 404, { error: 'unknown user' });
      throw e;
    }
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/stats' && req.method === 'GET') {
    const userId = Number(url.searchParams.get('userId'));
    if (!Number.isInteger(userId) || userId <= 0) return send(res, 400, { error: 'bad userId' });
    const today = isDay(url.searchParams.get('today'))
      ? url.searchParams.get('today')
      : dayKey(new Date());
    // The history screen walks every day from the day the name was claimed, so
    // a day with nothing on it reads as a gap rather than simply being absent.
    const since = await pool.query(`SELECT created_at FROM users WHERE id = $1`, [userId]);
    if (!since.rows.length) return send(res, 404, { error: 'unknown user' });
    const rows = await pool.query(
      `SELECT day,
              COUNT(*)::int                              AS total,
              COUNT(*) FILTER (WHERE correct)::int       AS correct,
              COUNT(*) FILTER (WHERE skipped)::int       AS skipped
         FROM attempts
        WHERE user_id = $1
        GROUP BY day
        ORDER BY day DESC`,
      [userId]
    );
    const days = rows.rows.map((r) => ({
      day: dayKey(r.day), total: r.total, correct: r.correct, skipped: r.skipped,
    }));
    const totals = days.reduce(
      (a, d) => ({ total: a.total + d.total, correct: a.correct + d.correct, days: a.days + 1 }),
      { total: 0, correct: 0, days: 0 }
    );
    return send(res, 200, {
      since: dayKey(since.rows[0].created_at),
      days: days,
      today: days.find((d) => d.day === today) || { day: today, total: 0, correct: 0, skipped: 0 },
      streak: streakFrom(days, today),
      bestStreak: bestStreakFrom(days),
      totals,
    });
  }

  // ---- the shared melody library ----
  if (url.pathname === '/api/melodies' && req.method === 'POST') {
    const body = await readJson(req);
    const text = (v, max) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);
    const song = text(body.song, 80);
    const artist = text(body.artist, 80);
    const part = text(body.part, 24).toLowerCase();
    if (!song) return send(res, 400, { error: 'Give the song a name.' });
    if (!artist) return send(res, 400, { error: 'Who is it by?' });
    if (!PARTS.includes(part)) return send(res, 400, { error: 'Pick which part of the song this is.' });
    const take = body.take;
    if (!take || !Array.isArray(take.notes) || !take.notes.length) {
      return send(res, 400, { error: 'Nothing to save yet.' });
    }
    if (take.notes.length > 400) return send(res, 400, { error: 'That melody is too long to save.' });
    // Store only the fields the player reads back, so a stray key in the POST
    // body can never end up in the library.
    const clean = {
      notes: take.notes.slice(0, 400).map((n) => ({
        midi: Math.round(Number(n.midi)) || 0,
        startMs: Math.max(0, Math.round(Number(n.startMs)) || 0),
        durMs: Math.max(1, Math.round(Number(n.durMs)) || 1),
        restMs: Math.max(0, Math.round(Number(n.restMs)) || 0),
      })),
      lyrics: Array.isArray(take.lyrics) ? take.lyrics.slice(0, 400).map((w) => String(w || '').slice(0, 24)) : [],
      harmony: Array.isArray(take.harmony)
        ? take.harmony.slice(0, 400).map((h) => (h == null ? null : Math.round(Number(h)) || null))
        : [],
      key: take.key && Number.isFinite(Number(take.key.root))
        ? { root: Number(take.key.root), type: take.key.type === 'minor' ? 'minor' : 'major' }
        : null,
      style: take.style ? String(take.style).slice(0, 24) : null,
    };
    if (clean.notes.some((n) => n.midi < 12 || n.midi > 108)) {
      return send(res, 400, { error: 'That melody has notes outside the piano.' });
    }
    const userId = Number(body.userId);
    const row = await pool.query(
      `INSERT INTO melodies (user_id, added_by, song, artist, part, take, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, song, artist, part, added_by, created_at`,
      [Number.isInteger(userId) && userId > 0 ? userId : null,
       text(body.addedBy, 24) || null, song, artist, part, JSON.stringify(clean),
       body.source === 'piano' ? 'piano' : 'voice']
    );
    return send(res, 200, { melody: Object.assign(row.rows[0], { id: Number(row.rows[0].id) }) });
  }

  if (url.pathname === '/api/melodies' && req.method === 'GET') {
    const rows = await pool.query(
      `SELECT id, song, artist, part, added_by, source, created_at,
              jsonb_array_length(take -> 'notes') AS note_count
         FROM melodies
        ORDER BY created_at DESC
        LIMIT 100`
    );
    return send(res, 200, {
      melodies: rows.rows.map((r) => ({
        id: Number(r.id), song: r.song, artist: r.artist, part: r.part,
        addedBy: r.added_by, source: r.source, noteCount: r.note_count,
      })),
    });
  }

  // ---- Song Vocals: split stems kept for later ----
  if (url.pathname === '/api/uploads' && req.method === 'POST') {
    if (!LALAL_KEY) return send(res, 503, { error: 'splitting unavailable' });
    const body = await readJson(req);
    const title = cleanText(body.title, 120);
    if (!title) return send(res, 400, { error: 'Give the track a name.' });
    const stem = STEMS.includes(body.stem) ? body.stem : 'vocals';
    const taskId = cleanText(body.taskId, 64);
    // Both halves are fetched before anything is written, so a track never
    // lands in the library with one side missing.
    const parts = {};
    for (const type of ['stem', 'back']) {
      const track = await lalalTrack(taskId, type);
      if (!track) return send(res, 404, { error: 'That split has expired — run it again.' });
      const audio = await fetch(track.url);
      if (!audio.ok) return send(res, 502, { error: 'could not fetch the split track' });
      const buffer = Buffer.from(await audio.arrayBuffer());
      if (buffer.length > STORE_LIMIT) {
        return send(res, 413, { error: 'That track is too long to keep — split a shorter section.' });
      }
      parts[type] = buffer;
    }
    const userId = Number(body.userId);
    const row = await pool.query(
      `INSERT INTO uploads (user_id, added_by, title, stem, stem_audio, back_audio)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, stem, added_by, created_at`,
      [Number.isInteger(userId) && userId > 0 ? userId : null,
       cleanText(body.addedBy, 24) || null, title, stem, parts.stem, parts.back]
    );
    return send(res, 200, { upload: Object.assign(row.rows[0], { id: Number(row.rows[0].id) }) });
  }

  if (url.pathname === '/api/uploads' && req.method === 'GET') {
    // The audio itself is fetched a track at a time; listing it would send the
    // whole library down the wire.
    const rows = await pool.query(
      `SELECT id, title, stem, added_by, created_at,
              octet_length(stem_audio) AS stem_bytes
         FROM uploads
        ORDER BY created_at DESC
        LIMIT 100`
    );
    return send(res, 200, {
      uploads: rows.rows.map((r) => ({
        id: Number(r.id), title: r.title, stem: r.stem, addedBy: r.added_by,
        stemBytes: Number(r.stem_bytes), createdAt: r.created_at,
      })),
    });
  }

  const upload = url.pathname.match(/^\/api\/uploads\/(\d+)\/audio$/);
  if (upload && req.method === 'GET') {
    const column = url.searchParams.get('type') === 'back' ? 'back_audio' : 'stem_audio';
    const row = await pool.query(`SELECT ${column} AS audio FROM uploads WHERE id = $1`, [Number(upload[1])]);
    if (!row.rows.length) return send(res, 404, { error: 'not found' });
    return send(res, 200, row.rows[0].audio, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'private, max-age=3600',
    });
  }

  const dropUpload = url.pathname.match(/^\/api\/uploads\/(\d+)$/);
  if (dropUpload && req.method === 'DELETE') {
    await pool.query(`DELETE FROM uploads WHERE id = $1`, [Number(dropUpload[1])]);
    return send(res, 200, { ok: true });
  }

  const one = url.pathname.match(/^\/api\/melodies\/(\d+)$/);
  if (one && req.method === 'GET') {
    const row = await pool.query(
      `SELECT id, song, artist, part, added_by, source, take FROM melodies WHERE id = $1`,
      [Number(one[1])]
    );
    if (!row.rows.length) return send(res, 404, { error: 'not found' });
    const m = row.rows[0];
    return send(res, 200, {
      melody: { id: Number(m.id), song: m.song, artist: m.artist, part: m.part,
                addedBy: m.added_by, source: m.source, take: m.take },
    });
  }

  return send(res, 404, { error: 'not found' });
}

// ---- static files ----
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.mp3': 'audio/mpeg', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.join(ROOT, rel);
  // Keep requests inside the app directory — path.join happily walks out of it.
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    return send(res, 403, { error: 'forbidden' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // The page changes on every deploy; the samples never do.
    const cache = path.extname(file) === '.mp3' ? 'public, max-age=31536000, immutable' : 'no-cache';
    send(res, 200, data, { 'Content-Type': type, 'Cache-Control': cache });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error('api error', err);
      if (!res.headersSent) send(res, 500, { error: 'server error' });
    });
    return;
  }
  serveStatic(req, res, url);
});

initDb()
  .catch((err) => console.error('database setup failed — serving without tracking:', err.message))
  .finally(() => server.listen(PORT, () => console.log(`listening on ${PORT}`)));
