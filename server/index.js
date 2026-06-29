const express = require('express');
const app = express();
app.use(express.json());

// In-memory fake "database" of valid users
const USERS = {
  alice: 'pass123', bob: 'pass456', carol: 'pass789',
  dave: 'pass000', eve: 'pass111', frank: 'pass222',
  grace: 'pass333', henry: 'pass444', iris: 'pass555',
  jack: 'pass666',
};

// Simple in-memory token store: token -> username
const TOKENS = new Map();

// ── Route 1: Health check ─────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// ── Route 2: Login (returns fake JWT-like token) ──────────────────────────────
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  if (USERS[username] !== password) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  // Fake "token" – just a base64 blob, not real crypto
  const token = Buffer.from(`${username}:${Date.now()}:secret`).toString('base64');
  TOKENS.set(token, username);

  // Auto-expire after 60 s so the token map doesn't grow forever during soak tests
  setTimeout(() => TOKENS.delete(token), 60_000);

  res.json({ token, expiresIn: 60 });
});

// ── Route 3: Protected profile ────────────────────────────────────────────────
app.get('/profile', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');

  if (!token || !TOKENS.has(token)) {
    return res.status(401).json({ error: 'unauthorized – missing or invalid token' });
  }

  const username = TOKENS.get(token);
  res.json({
    username,
    email: `${username}@example.com`,
    role: 'user',
    fetchedAt: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀  Target app listening on http://localhost:${PORT}`));
