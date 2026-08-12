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

// ---------- schema ----------
await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    user_id    TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    code       TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS friendships (
    user_id    TEXT NOT NULL,
    friend_id  TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, friend_id)
  );
  CREATE INDEX IF NOT EXISTS friendships_user_idx ON friendships (user_id);

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
  CREATE INDEX IF NOT EXISTS claims_user_idx ON claims (user_id);

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

// ---------- identity ----------
// No login. The app sends a random device id it generated on first launch.
// A short friend code is what people actually share with each other.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const WORDS = ['echo', 'dusk', 'ferry', 'amber', 'pine', 'harbor', 'lark', 'onyx', 'juno', 'wren'];

const makeCode = () =>
  Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

async function ensureUser(id, preferredName) {
  const { rows } = await pool.query('SELECT user_id, username, code FROM users WHERE user_id = $1', [id]);
  if (rows.length) return rows[0];

  const username = (preferredName || WORDS[Math.floor(Math.random() * WORDS.length)] + Math.floor(Math.random() * 900 + 100)).slice(0, 24);

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const { rows: made } = await pool.query(
        'INSERT INTO users (user_id, username, code) VALUES ($1,$2,$3) RETURNING user_id, username, code',
        [id, username, makeCode()]
      );
      return made[0];
    } catch (e) {
      if (e.code !== '23505') throw e; // retry only on code collision
    }
  }
  throw new Error('Could not allocate a friend code');
}

async function requireUser(req, res, next) {
  const id = req.header('x-user-id');
  if (!id || id.length < 8 || id.length > 64) {
    return res.status(400).json({ error: 'Missing x-user-id' });
  }
  try {
    req.user = await ensureUser(id, req.body?.username);
    req.userId = id;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ---------- spotify / library search ----------
let tokenCache = { value: null, expires: 0 };
const HAS_SPOTIFY = !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);

async function spotifyToken() {
  if (tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(
        `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
      ).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('Spotify auth failed');
  const data = await res.json();
  tokenCache = { value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return tokenCache.value;
}

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
    res.json((data.tracks?.items ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      artist: t.artists.map((a) => a.name).join(', '),
      art: t.album?.images?.[2]?.url ?? t.album?.images?.[0]?.url ?? null,
    })));
  } catch {
    res.json(searchLibrary(q));
  }
});

// ---------- shaping ----------
const SELECT = `
  SELECT c.id, c.cell, c.track_id, c.track_name, c.track_artist, c.track_art,
         c.user_id, COALESCE(u.username, c.username) AS username,
         c.note, (c.photo IS NOT NULL) AS photo, c.world_first, c.created_at
  FROM claims c LEFT JOIN users u ON u.user_id = c.user_id`;

async function hydrate(rows, viewerId) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);

  const { rows: reactions } = await pool.query(
    'SELECT claim_id, emoji, user_id FROM reactions WHERE claim_id = ANY($1)', [ids]
  );
  const { rows: comments } = await pool.query(
    `SELECT cm.id, cm.claim_id, cm.user_id, COALESCE(u.username, cm.username) AS username,
            cm.text, cm.created_at
     FROM comments cm LEFT JOIN users u ON u.user_id = cm.user_id
     WHERE cm.claim_id = ANY($1) ORDER BY cm.created_at`, [ids]
  );

  let friendSet = new Set();
  if (viewerId) {
    const { rows: fr } = await pool.query(
      'SELECT friend_id FROM friendships WHERE user_id = $1', [viewerId]
    );
    friendSet = new Set(fr.map((f) => f.friend_id));
  }

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
      isFriend: friendSet.has(r.user_id),
      note: r.note ?? undefined,
      photoUri: r.photo ? `${process.env.PUBLIC_URL ?? ''}/photo/${r.id}` : undefined,
      worldFirst: r.world_first,
      createdAt: r.created_at.toISOString(),
      reactions: reactionMap,
      comments: comments.filter((cm) => cm.claim_id === r.id).map((cm) => ({
        id: String(cm.id),
        userId: cm.user_id,
        username: cm.username,
        text: cm.text,
        createdAt: cm.created_at.toISOString(),
      })),
    };
  });
}

// ---------- profile ----------
app.get('/me', requireUser, async (req, res) => {
  try {
    const { rows: counts } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM claims WHERE user_id = $1) AS spots,
         (SELECT COUNT(*) FROM claims WHERE user_id = $1 AND world_first) AS firsts,
         (SELECT COUNT(*) FROM friendships WHERE user_id = $1) AS friends`,
      [req.userId]
    );
    res.json({
      userId: req.user.user_id,
      username: req.user.username,
      code: req.user.code,
      spots: Number(counts[0].spots),
      firsts: Number(counts[0].firsts),
      friends: Number(counts[0].friends),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/me', requireUser, async (req, res) => {
  const username = (req.body?.username ?? '').toString().trim().slice(0, 24);
  if (!username) return res.status(400).json({ error: 'Name cannot be empty' });
  try {
    await pool.query('UPDATE users SET username = $2 WHERE user_id = $1', [req.userId, username]);
    res.json({ userId: req.userId, username, code: req.user.code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- friends ----------
app.get('/friends', requireUser, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.user_id, u.username, u.code,
              (SELECT COUNT(*) FROM claims WHERE user_id = u.user_id) AS spots,
              EXISTS (SELECT 1 FROM friendships f2
                      WHERE f2.user_id = u.user_id AND f2.friend_id = $1) AS follows_back
       FROM friendships f JOIN users u ON u.user_id = f.friend_id
       WHERE f.user_id = $1
       ORDER BY u.username`,
      [req.userId]
    );
    res.json(rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      code: r.code,
      spots: Number(r.spots),
      followsBack: r.follows_back,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/friends', requireUser, async (req, res) => {
  const code = (req.body?.code ?? '').toString().trim().toUpperCase();
  if (code.length !== 6) return res.status(400).json({ error: 'A friend code is 6 characters' });
  try {
    const { rows } = await pool.query(
      'SELECT user_id, username, code FROM users WHERE code = $1', [code]
    );
    if (!rows.length) return res.status(404).json({ error: 'No one has that code' });
    if (rows[0].user_id === req.userId) {
      return res.status(400).json({ error: "That's your own code" });
    }
    await pool.query(
      'INSERT INTO friendships (user_id, friend_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.userId, rows[0].user_id]
    );
    res.json({ userId: rows[0].user_id, username: rows[0].username, code: rows[0].code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/friends/:id', requireUser, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM friendships WHERE user_id = $1 AND friend_id = $2',
      [req.userId, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/feed', requireUser, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${SELECT}
       WHERE c.user_id IN (SELECT friend_id FROM friendships WHERE user_id = $1)
       ORDER BY c.created_at DESC LIMIT 100`,
      [req.userId]
    );
    res.json(await hydrate(rows, req.userId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- claims ----------
app.get('/claims', async (req, res) => {
  const cells = (req.query.cells ?? '').toString().split(',').filter(Boolean);
  const viewer = req.header('x-user-id') ?? null;
  if (!cells.length) return res.json([]);
  try {
    const { rows } = await pool.query(
      `${SELECT} WHERE c.cell = ANY($1) ORDER BY c.created_at DESC LIMIT 500`, [cells]
    );
    res.json(await hydrate(rows, viewer));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/claims/mine', requireUser, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${SELECT} WHERE c.user_id = $1 ORDER BY c.created_at DESC LIMIT 200`, [req.userId]
    );
    res.json(await hydrate(rows, req.userId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/photo/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT photo FROM claims WHERE id = $1', [req.params.id]);
    if (!rows[0]?.photo) return res.status(404).end();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(Buffer.from(rows[0].photo, 'base64'));
  } catch {
    res.status(500).end();
  }
});

app.post('/claims', requireUser, async (req, res) => {
  const { cell, track, lat, lng, note, photoBase64 } = req.body ?? {};
  if (!cell || !track?.id || typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'Bad payload' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      `${SELECT} WHERE c.cell = $1 AND c.track_id = $2`, [cell, track.id]
    );
    if (existing.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ existing: (await hydrate(existing, req.userId))[0] });
    }

    const { rows: seen } = await client.query(
      'SELECT 1 FROM claims WHERE track_id = $1 LIMIT 1', [track.id]
    );

    const { rows } = await client.query(
      `INSERT INTO claims
        (cell, track_id, track_name, track_artist, track_art, user_id, username,
         note, photo, lat, lng, world_first)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        cell, track.id, track.name, track.artist, track.art ?? null,
        req.userId, req.user.username,
        note?.slice(0, 200) ?? null, photoBase64 ?? null,
        lat, lng, seen.length === 0,
      ]
    );

    await client.query('COMMIT');

    const { rows: full } = await pool.query(`${SELECT} WHERE c.id = $1`, [rows[0].id]);
    res.json((await hydrate(full, req.userId))[0]);
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
    const { rows } = await pool.query(`${SELECT} WHERE c.id = $1`, [req.params.id]);
    res.json((await hydrate(rows, req.userId))[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/claims/:id/comments', requireUser, async (req, res) => {
  const text = (req.body?.text ?? '').toString().trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'Empty comment' });
  try {
    await pool.query(
      'INSERT INTO comments (claim_id, user_id, username, text) VALUES ($1,$2,$3,$4)',
      [req.params.id, req.userId, req.user.username, text]
    );
    const { rows } = await pool.query(`${SELECT} WHERE c.id = $1`, [req.params.id]);
    res.json((await hydrate(rows, req.userId))[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (_req, res) =>
  res.json({ ok: true, service: 'firstplay', search: HAS_SPOTIFY ? 'spotify' : 'built-in library' })
);

const port = process.env.PORT || 8787;
app.listen(port, () => console.log('listening on ' + port));
