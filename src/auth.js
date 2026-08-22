import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { col, nextId, seedDefaults } from './db.js';

const SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret';
const TOKEN_TTL = '30d';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, derived] = String(stored).split(':');
  if (!salt || !derived) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(derived, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function sign(user) {
  return jwt.sign({ sub: user._id, email: user.email }, SECRET, { expiresIn: TOKEN_TTL });
}

function publicUser(u) {
  return { id: u._id, email: u.email, name: u.name, currency: u.currency };
}

export async function registerUser({ email, name, password, currency = 'INR' }) {
  const normalized = String(email).trim().toLowerCase();
  if (await col.users.findOne({ email: normalized })) {
    const err = new Error('An account with that email already exists');
    err.status = 409;
    throw err;
  }

  const user = {
    _id: await nextId('users'),
    email: normalized,
    name: String(name).trim(),
    password_hash: hashPassword(password),
    currency,
    created_at: new Date().toISOString(),
  };

  try {
    await col.users.insertOne(user);
  } catch (err) {
    // The unique index is the real guard against a concurrent duplicate signup.
    if (err.code === 11000) {
      const conflict = new Error('An account with that email already exists');
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }

  await seedDefaults(user._id);
  return { token: sign(user), user: publicUser(user) };
}

export async function loginUser({ email, password }) {
  const user = await col.users.findOne({ email: String(email).trim().toLowerCase() });
  if (!user || !verifyPassword(password, user.password_hash)) {
    const err = new Error('Invalid email or password');
    err.status = 401;
    throw err;
  }
  return { token: sign(user), user: publicUser(user) };
}

export async function getUser(id) {
  const u = await col.users.findOne({ _id: Number(id) });
  return u ? publicUser(u) : null;
}

/** Express middleware — reads a bearer token, or `?token=` for EventSource requests. */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ error: 'Session expired — please sign in again' });
  }

  try {
    const user = await getUser(payload.sub);
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
