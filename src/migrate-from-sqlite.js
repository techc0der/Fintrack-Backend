/**
 * One-off: copies a pre-Mongo `fintrack.db` into MongoDB.
 *
 *   node src/migrate-from-sqlite.js            # uses SQLITE_FILE or ./fintrack.db
 *   node src/migrate-from-sqlite.js --wipe     # clears the target collections first
 *
 * Safe to re-run: documents keep their original numeric ids and are upserted, so
 * a second pass overwrites rather than duplicating.
 */
import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { connect, close, col } from './db.js';

const file = path.resolve(process.cwd(), process.env.SQLITE_FILE || './fintrack.db');
const wipe = process.argv.includes('--wipe');

const TABLES = [
  ['users', 'users'],
  ['accounts', 'accounts'],
  ['categories', 'categories'],
  ['transactions', 'transactions'],
  ['budgets', 'budgets'],
  ['goals', 'goals'],
  ['chat_messages', 'chat_messages'],
];

if (!fs.existsSync(file)) {
  console.error(`No SQLite database at ${file}`);
  console.error('Set SQLITE_FILE=/path/to/fintrack.db if it lives elsewhere.');
  process.exit(1);
}

const sqlite = new DatabaseSync(file, { readOnly: true });
await connect();

if (wipe) {
  for (const [, name] of TABLES) await col[name].deleteMany({});
  await col.counters.deleteMany({});
  console.log('cleared target collections');
}

let grandTotal = 0;

for (const [table, name] of TABLES) {
  let rows;
  try {
    rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
  } catch {
    console.log(`${table.padEnd(15)} — not present in the SQLite file, skipped`);
    continue;
  }

  if (rows.length === 0) {
    console.log(`${table.padEnd(15)} 0`);
    continue;
  }

  const ops = rows.map((row) => {
    // SQLite's `id` becomes Mongo's `_id`; everything else carries over as-is.
    const { id, ...rest } = row;
    return {
      replaceOne: {
        filter: { _id: id },
        replacement: { _id: id, ...rest },
        upsert: true,
      },
    };
  });

  await col[name].bulkWrite(ops, { ordered: false });

  // Park the counter above the highest id so new inserts never collide.
  const maxId = Math.max(...rows.map((r) => r.id));
  await col.counters.updateOne(
    { _id: name },
    { $max: { seq: maxId } },
    { upsert: true }
  );

  grandTotal += rows.length;
  console.log(`${table.padEnd(15)} ${rows.length}  (counter -> ${maxId})`);
}

sqlite.close();

const users = await col.users.countDocuments();
const tx = await col.transactions.countDocuments();
console.log(`\nMigrated ${grandTotal} rows. MongoDB now holds ${users} user(s) and ${tx} transaction(s).`);

await close();
