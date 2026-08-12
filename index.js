import express from 'express';
import cors from 'cors';
import pg from 'pg';
import { LIBRARY } from './library.js';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' }));

// ---------- identity ----------
// No login. The app sends a random device id it generated on first launch.
function userId(req) {
  const id = req.header('x-user-id');
  if (!id || id.length < 8 || id.length > 64) return null;
  return id;
}

function requireUser(req, res, next) {
  const id = userId(req);
  if (!id) return res.status(400).json({ error: 'Missing x-user-id' });
  req.userId = id;
  next();
}

// ---------- schema ----------
await pool.query(`
  CREATE TABLE IF NOT EXISTS claims (
    id           BIGSERIAL PRIMARY KEY,
    cell         TEXT NOT NULL,
    track_id     TEXT NOT NULL,
    track_name   TEXT NOT NULL,
    track_artist TEXT NOT NULL,
    track_art    TEXT,
    user_id      TEXT NOT NULL,
    username     TEXT NOT NULL,
    note         TEXT,
    photo        TEXT,
    lat          DOUBLE PRECISION NOT NULL,
    lng          DOUBLE PRECISION NOT NULL,
    world_first  BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cell, track_id)
  );
  CREATE INDEX IF NOT EXISTS claims_cell_idx ON claims (cell);
  CREATE INDEX IF NOT EXISTS claims_track_idx ON claims (track_id);

  CREATE TABLE IF NOT EXISTS reactions (
    claim_id BIGINT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL,
    emoji    TEXT NOT NULL,
    PRIMARY KEY (claim_id, user_id, emoji)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         BIGSERIAL PRIMARY KEY,
    claim_id   BIGINT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL,
    username   TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS comments_claim_idx ON comments (claim_id);
`);

// ---------- spotify (server-side credentials) ----------
let tokenCache = { value: null, expires: 0 };

async function spotifyToken() {
  if (tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;

  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Spotify credentials not configured');

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('Spotify auth failed');

  const data = await res.json();
  tokenCache = { value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return tokenCache.value;
}

const HAS_SPOTIFY = !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);

function searchLibrary(q) {
  const needle = q.toLowerCase();
  const scored = [];
  for (const t of LIBRARY) {
    const name = t.name.toLowerCase();
    const artist = t.artist.toLowerCase();
    let score = -1;
    if (name.startsWith(needle)) score = 0;
    else if (artist.startsWith(needle)) score = 1;
    else if (name.includes(needle)) score = 2;
    else if (artist.includes(needle)) score = 3;
    if (score >= 0) scored.push({ score, track: { ...t, art: null } });
  }
  scored.sort((a, b) => a.score - b.score || a.track.name.localeCompare(b.track.name));
  return scored.slice(0, 12).map((x) => x.track);
}

app.get('/search', async (req, res) => {
  const q = (req.query.q ?? '').toString().trim();
  if (!q) return res.json([]);

  if (!HAS_SPOTIFY) return res.json(searchLibrary(q));

  try {
    const token = await spotifyToken();
    const r = await fetch(
      `https://api.spotify.com/v1/search?type=track&limit=12&q=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) return res.json(searchLibrary(q));
    const data = await r.json();
    res.json(
      (data.tracks?.items ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        artist: t.artists.map((a) => a.name).join(', '),
        art: t.album?.images?.[2]?.url ?? t.album?.images?.[0]?.url ?? null,
      }))
    );
  } catch {
    res.json(searchLibrary(q));
  }
});

// ---------- shaping ----------
async function hydrate(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);

  const { rows: reactions } = await pool.query(
    'SELECT claim_id, emoji, user_id FROM reactions WHERE claim_id = ANY($1)',
    [ids]
  );
  const { rows: comments } = await pool.query(
    'SELECT id, claim_id, user_id, username, text, created_at FROM comments WHERE claim_id = ANY($1) ORDER BY created_at',
    [ids]
  );

  return rows.map((r) => {
    const reactionMap = {};
    for (const x of reactions.filter((x) => x.claim_id === r.id)) {
      (reactionMap[x.emoji] ??= []).push(x.user_id);
    }
    return {
      id: String(r.id),
      cell: r.cell,
      track: { id: r.track_id, name: r.track_name, artist: r.track_artist, art: r.track_art },
      userId: r.user_id,
      username: r.username,
      note: r.note ?? undefined,
      photoUri: r.photo ? `${process.env.PUBLIC_URL ?? ''}/photo/${r.id}` : undefined,
      worldFirst: r.world_first,
      createdAt: r.created_at.toISOString(),
      reactions: reactionMap,
      comments: comments
        .filter((c) => c.claim_id === r.id)
        .map((c) => ({
          id: String(c.id),
          userId: c.user_id,
          username: c.username,
          text: c.text,
          createdAt: c.created_at.toISOString(),
        })),
    };
  });
}

const SELECT = `SELECT id, cell, track_id, track_name, track_artist, track_art,
  user_id, username, note, (photo IS NOT NULL) AS photo, world_first, created_at FROM claims`;

// ---------- claims ----------
app.get('/claims', async (req, res) => {
  const cells = (req.query.cells ?? '').toString().split(',').filter(Boolean);
  if (!cells.length) return res.json([]);
  try {
    const { rows } = await pool.query(
      `${SELECT} WHERE cell = ANY($1) ORDER BY created_at DESC LIMIT 500`,
      [cells]
    );
    res.json(await hydrate(rows));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/claims/mine', requireUser, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${SELECT} WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.userId]
    );
    res.json(await hydrate(rows));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/photo/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT photo FROM claims WHERE id = $1', [req.params.id]);
    if (!rows[0]?.photo) return res.status(404).end();
    const buf = Buffer.from(rows[0].photo, 'base64');
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buf);
  } catch {
    res.status(500).end();
  }
});

app.post('/claims', requireUser, async (req, res) => {
  const { cell, track, lat, lng, note, username, photoBase64 } = req.body ?? {};
  if (!cell || !track?.id || typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'Bad payload' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      `${SELECT} WHERE cell = $1 AND track_id = $2`,
      [cell, track.id]
    );
    if (existing.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ existing: (await hydrate(existing))[0] });
    }

    const { rows: seen } = await client.query(
      'SELECT 1 FROM claims WHERE track_id = $1 LIMIT 1',
      [track.id]
    );

    const { rows } = await client.query(
      `INSERT INTO claims
        (cell, track_id, track_name, track_artist, track_art, user_id, username,
         note, photo, lat, lng, world_first)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, cell, track_id, track_name, track_artist, track_art,
         user_id, username, note, (photo IS NOT NULL) AS photo, world_first, created_at`,
      [
        cell, track.id, track.name, track.artist, track.art ?? null,
        req.userId, (username || 'someone').slice(0, 24),
        note?.slice(0, 200) ?? null, photoBase64 ?? null,
        lat, lng, seen.length === 0,
      ]
    );

    await client.query('COMMIT');
    res.json((await hydrate(rows))[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'Already claimed' });
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---------- reactions & comments ----------
app.post('/claims/:id/reactions', requireUser, async (req, res) => {
  const emoji = (req.body?.emoji ?? '').toString().slice(0, 8);
  if (!emoji) return res.status(400).json({ error: 'Missing emoji' });
  try {
    const del = await pool.query(
      'DELETE FROM reactions WHERE claim_id=$1 AND user_id=$2 AND emoji=$3',
      [req.params.id, req.userId, emoji]
    );
    if (!del.rowCount) {
      await pool.query(
        'INSERT INTO reactions (claim_id, user_id, emoji) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [req.params.id, req.userId, emoji]
      );
    }
    const { rows } = await pool.query(`${SELECT} WHERE id = $1`, [req.params.id]);
    res.json((await hydrate(rows))[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/claims/:id/comments', requireUser, async (req, res) => {
  const text = (req.body?.text ?? '').toString().trim().slice(0, 300);
  const username = (req.body?.username || 'someone').slice(0, 24);
  if (!text) return res.status(400).json({ error: 'Empty comment' });
  try {
    await pool.query(
      'INSERT INTO comments (claim_id, user_id, username, text) VALUES ($1,$2,$3,$4)',
      [req.params.id, req.userId, username, text]
    );
    const { rows } = await pool.query(`${SELECT} WHERE id = $1`, [req.params.id]);
    res.json((await hydrate(rows))[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (_req, res) =>
  res.json({ ok: true, service: 'firstplay', search: HAS_SPOTIFY ? 'spotify' : 'built-in library' })
);

const port = process.env.PORT || 8787;
app.listen(port, () => console.log('listening on ' + port));
