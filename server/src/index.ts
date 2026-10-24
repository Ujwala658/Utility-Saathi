import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb } from './db/index.js';
import { resetDemoData } from './db/seed.js';

const port = Number(process.env.PORT ?? 3001);
const dbFile = process.env.DATABASE_FILE ?? 'utility-saathi.db';
const db = openDb(dbFile);
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  resetDemoData(db);
  console.log('[seed] Loaded synthetic demo data');
}
const app = createApp(db, { allowDemoReset: process.env.ALLOW_DEMO_RESET !== 'false' });
// Serve the built client (npm run build) from the same origin, with SPA fallback.
const dist = fileURLToPath(new URL('../../client/dist', import.meta.url));
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(`${dist}/index.html`));
}
app.listen(port, () => console.log(`[server] Utility Saathi API on http://localhost:${port}`));
