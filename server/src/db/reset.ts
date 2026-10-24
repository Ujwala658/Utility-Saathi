import { openDb } from './index.js';
import { resetDemoData } from './seed.js';

const file = process.env.DATABASE_FILE ?? 'utility-saathi.db';
resetDemoData(openDb(file));
console.log(`[seed] Synthetic demo data reset in ${file}`);
