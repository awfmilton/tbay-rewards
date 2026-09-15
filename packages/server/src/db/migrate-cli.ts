import { closeDb } from './pool.js';
import { migrate } from './migrate.js';

const result = await migrate((message) => console.log(`[migrate] ${message}`));

if (result.applied.length === 0) {
  console.log(`[migrate] up to date (${result.skipped.length} migrations already applied)`);
} else {
  console.log(`[migrate] applied ${result.applied.length} migration(s)`);
}

await closeDb();
