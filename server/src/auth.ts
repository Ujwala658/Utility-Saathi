import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { DB } from './db/index.js';
import { AppError } from './errors.js';

export type Role = 'tenant' | 'owner' | 'admin';
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  is_demo: number;
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SESSION_HOURS = 8;

/** scrypt with a per-password random salt. Format: scrypt$N$r$p$salt$hash (hex). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('hex'), hash.toString('hex')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, N, r, p, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Creates a session and returns the bearer token. Only its hash is stored. */
export function createSession(db: DB, userId: string, now = new Date()): string {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(now.getTime() + SESSION_HOURS * 3_600_000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, expires, now.toISOString());
  return token;
}

export function deleteSession(db: DB, token: string) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      token?: string;
    }
  }
}

/** Bearer-token auth. Tokens live in the client's memory/sessionStorage, not cookies, so CSRF does not apply. */
export function requireAuth(db: DB) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return next(new AppError(401, 'UNAUTHENTICATED', 'Please sign in'));
    const user = db
      .prepare(
        `SELECT u.id, u.email, u.name, u.role, u.is_demo FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(sha256(token), new Date().toISOString()) as SessionUser | undefined;
    if (!user) return next(new AppError(401, 'UNAUTHENTICATED', 'Session expired. Please sign in again'));
    req.user = user;
    req.token = token;
    next();
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return next(new AppError(403, 'FORBIDDEN', 'Your role cannot do this'));
    next();
  };
}

/** Small fixed-window limiter for sensitive endpoints (login, payment initiation). In-memory: per process only. */
export function rateLimit({ windowMs, max, key }: { windowMs: number; max: number; key: (req: Request) => string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, _res: Response, next: NextFunction) => {
    const k = key(req);
    const now = Date.now();
    const entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      hits.set(k, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) return next(new AppError(429, 'RATE_LIMITED', 'Too many attempts. Please wait a minute and try again'));
    next();
  };
}
