/**
 * Copies every FinTrack collection from one MongoDB to another — typically a
 * local server up to Atlas.
 *
 *   SOURCE_URI=mongodb://127.0.0.1:27017 \
 *   TARGET_URI="mongodb+srv://user:pass@host/?retryWrites=true&w=majority" \
 *   node src/copy-mongo.js
 *
 * Defaults: SOURCE_URI falls back to mongodb://127.0.0.1:27017, TARGET_URI to
 * MONGODB_URI from .env. Add --wipe to clear the target collections first.
 *
 * Documents keep their ids and are upserted, so re-running overwrites rather
 * than duplicating. The `counters` collection is copied last and clamped to the
 * highest id actually present, so new inserts on the target cannot collide.
 */
import 'dotenv/config';
import dns from 'node:dns';
import { MongoClient } from 'mongodb';

if (process.env.DNS_SERVERS) {
  dns.setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean));
}

const SOURCE_URI = process.env.SOURCE_URI || 'mongodb://127.0.0.1:27017';
const TARGET_URI = process.env.TARGET_URI || process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'fintrack';
const wipe = process.argv.includes('--wipe');

const COLLECTIONS = [
  'users',
  'accounts',
  'categories',
  'transactions',
  'budgets',
  'goals',
  'chat_messages',
];

if (!TARGET_URI) {
  console.error('Set TARGET_URI (or MONGODB_URI in .env) to the destination cluster.');
  process.exit(1);
}
if (SOURCE_URI === TARGET_URI) {
  console.error('SOURCE_URI and TARGET_URI are the same. Nothing to do.');
  process.exit(1);
}

const redact = (uri) => uri.replace(/(\/\/[^:]*:)[^@]*@/, '$1<password>@');
console.log(`source: ${redact(SOURCE_URI)}`);
console.log(`target: ${redact(TARGET_URI)}\n`);

const source = new MongoClient(SOURCE_URI, { serverSelectionTimeoutMS: 15000 });
const target = new MongoClient(TARGET_URI, { serverSelectionTimeoutMS: 20000 });

try {
  await source.connect();
} catch (err) {
  console.error(`Could not reach the source: ${err.message.split('\n')[0]}`);
  process.exit(1);
}

try {
  await target.connect();
} catch (err) {
  console.error(`Could not reach the target: ${err.message.split('\n')[0]}`);
  if (/tlsv1 alert internal error/i.test(err.message)) {
    console.error('That TLS alert from Atlas almost always means this IP is not in Network Access.');
  }
  await source.close();
  process.exit(1);
}

const src = source.db(DB_NAME);
const dst = target.db(DB_NAME);

if (wipe) {
  for (const name of [...COLLECTIONS, 'counters']) await dst.collection(name).deleteMany({});
  console.log('cleared target collections\n');
}

let total = 0;

for (const name of COLLECTIONS) {
  const docs = await src.collection(name).find({}).toArray();
  if (docs.length === 0) {
    console.log(`${name.padEnd(15)} 0`);
    continue;
  }

  await dst.collection(name).bulkWrite(
    docs.map((doc) => ({
      replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
    })),
    { ordered: false }
  );

  total += docs.length;
  console.log(`${name.padEnd(15)} ${docs.length}`);
}

// Counters last, clamped to what actually landed, so ids can never collide.
for (const name of COLLECTIONS) {
  const highest = await dst
    .collection(name)
    .find({}, { projection: { _id: 1 } })
    .sort({ _id: -1 })
    .limit(1)
    .toArray();
  const max = typeof highest[0]?._id === 'number' ? highest[0]._id : 0;
  if (max > 0) {
    await dst.collection('counters').updateOne({ _id: name }, { $max: { seq: max } }, { upsert: true });
  }
}

const counters = await dst.collection('counters').find({}).toArray();
console.log(`\ncounters       ${counters.map((c) => `${c._id}=${c.seq}`).join(', ')}`);
console.log(`\nCopied ${total} documents.`);

await source.close();
await target.close();
