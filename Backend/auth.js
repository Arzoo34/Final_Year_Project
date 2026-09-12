'use strict';

/**
 * SafeMine — API authentication: SQLite JWT (/api/auth/login) and/or Supabase JWT.
 * Mount at /api/auth. When AUTH_ENABLED=true, use createAuthApiGate(db) on /api
 * to require Bearer tokens for all routes except the public list below.
 * If SUPABASE_JWT_SECRET is set, Bearer tokens are verified as Supabase access JWTs.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

const SALT_ROUNDS = 10;
const JWT_DEFAULT_EXPIRES = process.env.JWT_EXPIRES_IN || '7d';
const SUPABASE_JWT_SECRET = (process.env.SUPABASE_JWT_SECRET || '').trim();

function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (process.env.AUTH_ENABLED === 'true') {
    const supabaseOk = SUPABASE_JWT_SECRET.length >= 8;
    const sqliteOk = s && s.length >= 16;
    if (!supabaseOk && !sqliteOk) {
      console.error('[Auth] AUTH_ENABLED=true: set SUPABASE_JWT_SECRET (Supabase login) and/or JWT_SECRET (min 16) for SQLite /api/auth tokens.');
      process.exit(1);
    }
  }
  return s || 'safemine-dev-only-not-for-production';
}

const JWT_SECRET = getJwtSecret();

if (!process.env.JWT_SECRET && process.env.AUTH_ENABLED !== 'true' && !SUPABASE_JWT_SECRET) {
  console.warn('[Auth] JWT_SECRET unset — using dev default for SQLite /api/auth tokens. Set JWT_SECRET or use Supabase (SUPABASE_JWT_SECRET).');
}

function verifySupabaseAccessToken(token) {
  if (!SUPABASE_JWT_SECRET) return null;
  try {
    return jwt.verify(token, SUPABASE_JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

/** Paths relative to /api (Express strips mount prefix in gate middleware). */
const PUBLIC_API_PATHS = new Set([
  '/health',
  '/telemetry',
  '/wristband',
  '/auth/login',
  '/auth/register',
  '/auth/public-config',
]);

function isPublicApiPath(pathname) {
  if (PUBLIC_API_PATHS.has(pathname)) return true;
  return false;
}

function createRequireAuth(db) {
  return function requireAuth(req, res, next) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (!m) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header (Bearer token required).' });
    }
    const token = m[1];

    if (SUPABASE_JWT_SECRET) {
      const payload = verifySupabaseAccessToken(token);
      if (!payload || !payload.sub) {
        return res.status(401).json({ error: 'Invalid or expired token.' });
      }
      req.user = {
        id: payload.sub,
        email: payload.email || '',
        name: (payload.user_metadata && payload.user_metadata.full_name) || '',
        role: payload.role || 'authenticated',
        source: 'supabase',
      };
      return next();
    }

    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const sub = payload.sub;
      if (!sub) {
        return res.status(401).json({ error: 'Invalid token payload.' });
      }
      const row = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(sub);
      if (!row) {
        return res.status(401).json({ error: 'User no longer exists.' });
      }
      req.user = {
        id: row.id,
        email: row.email,
        name: row.name || '',
        role: row.role || 'operator',
        source: 'sqlite',
      };
      next();
    } catch (e) {
      const msg = e.name === 'TokenExpiredError' ? 'Token expired.' : 'Invalid or expired token.';
      return res.status(401).json({ error: msg });
    }
  };
}

function signUserToken(userRow) {
  return jwt.sign(
    { sub: userRow.id, email: userRow.email, role: userRow.role || 'operator' },
    JWT_SECRET,
    { expiresIn: JWT_DEFAULT_EXPIRES }
  );
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name || '',
    role: row.role || 'operator',
  };
}

function createAuthRouter(db) {
  const router = express.Router();
  const requireAuth = createRequireAuth(db);

  router.get('/public-config', (req, res) => {
    const url = (process.env.SUPABASE_URL || '').trim();
    const anon = (process.env.SUPABASE_ANON_KEY || '').trim();
    res.json({
      authGateEnabled: process.env.AUTH_ENABLED === 'true',
      supabaseConfigured: !!(url && anon),
      supabaseUrl: url,
      supabaseAnonKey: anon,
      authMode: SUPABASE_JWT_SECRET ? 'supabase' : 'sqlite',
    });
  });

  router.post('/register', (req, res) => {
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const password = body.password;
    const name = String(body.name || '').trim();

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters.' });
    }

    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (exists) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const countRow = db.prepare('SELECT COUNT(*) AS c FROM users').get();
    const isFirst = !countRow || Number(countRow.c) === 0;
    const role = isFirst ? 'admin' : 'operator';

    const id = uuid();
    const now = new Date().toISOString();
    const passwordHash = bcrypt.hashSync(String(password), SALT_ROUNDS);

    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run([id, email, passwordHash, name, role, now]);

    const row = { id, email, name, role };
    const token = signUserToken(row);
    return res.status(201).json({
      token,
      user: publicUser(row),
      message: 'Registered successfully.',
    });
  });

  router.post('/login', (req, res) => {
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const password = body.password;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required.' });
    }

    const row = db.prepare(
      'SELECT id, email, password_hash, name, role FROM users WHERE email = ?'
    ).get(email);

    if (!row || !bcrypt.compareSync(String(password), row.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = signUserToken(row);
    return res.json({
      token,
      user: publicUser(row),
      message: 'Logged in successfully.',
    });
  });

  router.get('/me', requireAuth, (req, res) => {
    return res.json({ user: req.user });
  });

  return router;
}

/**
 * When AUTH_ENABLED=true, require a valid JWT for every /api route except
 * PUBLIC_API_PATHS and CORS preflight.
 */
function apiPathFromRequest(req) {
  const raw = (req.originalUrl || req.url || '').split('?')[0];
  if (raw.startsWith('/api')) {
    const rest = raw.slice(4) || '/';
    return rest.startsWith('/') ? rest : '/' + rest;
  }
  return raw || '/';
}

function createAuthApiGate(db) {
  const requireAuth = createRequireAuth(db);

  return function authApiGate(req, res, next) {
    if (process.env.AUTH_ENABLED !== 'true') {
      return next();
    }
    if (req.method === 'OPTIONS') {
      return next();
    }
    const p = apiPathFromRequest(req);
    if (isPublicApiPath(p)) {
      return next();
    }
    return requireAuth(req, res, next);
  };
}

module.exports = {
  createAuthRouter,
  createRequireAuth,
  createAuthApiGate,
  PUBLIC_API_PATHS,
  verifySupabaseAccessToken,
};
