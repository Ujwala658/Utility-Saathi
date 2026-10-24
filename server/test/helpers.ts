import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { DEMO_PASSWORD, resetDemoData } from '../src/db/seed.js';

export const EMAIL = {
  asha: 'asha.tenant@demo.utilitysaathi.in',
  karthik: 'karthik.tenant@demo.utilitysaathi.in',
  ravi: 'ravi.owner@demo.utilitysaathi.in',
  meera: 'meera.owner@demo.utilitysaathi.in',
  priya: 'priya.admin@demo.utilitysaathi.in',
};

export async function setup() {
  const db = openDb(':memory:');
  resetDemoData(db);
  const app = createApp(db, { rateLimits: false, allowDemoReset: true });
  const tokens: Record<string, string> = {};
  for (const [k, email] of Object.entries(EMAIL)) {
    const res = await request(app).post('/api/auth/login').send({ email, password: DEMO_PASSWORD });
    if (res.status !== 200) throw new Error(`login failed for ${email}`);
    tokens[k] = res.body.token;
  }
  const as = (who: keyof typeof EMAIL) => {
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${tokens[who]}`);
    return {
      get: (url: string) => auth(request(app).get(url)),
      post: (url: string, body: object = {}) => auth(request(app).post(url).send(body)),
      patch: (url: string, body: object = {}) => auth(request(app).patch(url).send(body)),
      del: (url: string) => auth(request(app).delete(url)),
    };
  };
  return { db, app, as };
}
