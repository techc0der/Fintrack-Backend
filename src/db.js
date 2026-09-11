import { MongoClient } from 'mongodb';
import dns from 'node:dns';

/**
 * `mongodb+srv://` needs an SRV lookup, which fails on machines whose resolver
 * list Node reads as something unreachable (a dead local DNS proxy leaves
 * 127.0.0.1 behind, and every query then comes back ECONNREFUSED). Setting
 * DNS_SERVERS overrides the resolver for this process only.
 *
 *   DNS_SERVERS=8.8.8.8,1.1.1.1
 *
 * Leave it unset in any normal environment — hosting platforms resolve fine.
 */
const dnsServers = (process.env.DNS_SERVERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (dnsServers.length) dns.setServers(dnsServers);

/**
 * The five money-flow types.
 *
 *   income   money in,  earned       counts toward income and savings rate
 *   borrow   money in,  a liability  excluded from income — it has to be paid back
 *   expense  money out, spending     counts toward expenses
 *   repay    money out, settling     excluded from expenses — it clears a liability
 *   invest   money out, preserved    excluded from expenses — it changes form, not owner
 *   lend     money out, owed to you  excluded from expenses — you get it back
 *   recover  money in,  yours again  excluded from income — it was already yours
 *
 * Keeping borrow/repay/invest out of the income and expense totals is the whole
 * point: a loan filed as income inflates the savings rate, and money moved into
 * a mutual fund has not been spent — you still own it.
 */
export const FLOW_TYPES = [
  'income',
  'expense',
  'invest',
  'borrow',
  'repay',
  'lend',
  'recover',
];
export const CREDIT_TYPES = ['income', 'borrow', 'recover'];

/**
 * The four flows that move money between you and other people. Net them and you
 * get the credit balance: positive means you are holding money that is not
 * yours, negative means your money is out with someone else.
 *
 *   borrow   they hand you money      +  you owe it back
 *   repay    you hand it back         -
 *   lend     you hand someone money   -  they owe it back
 *   recover  they hand it back        +
 */
export const DEBT_TYPES = ['borrow', 'repay', 'lend', 'recover'];
export const CREDIT_IN = ['borrow', 'recover'];
export const CREDIT_OUT = ['lend', 'repay'];

/**
 * Whose money this is. The hisaab ledger keeps two purses side by side and never
 * mixes them: every figure on that page is reported per owner.
 */
export const OWNERS = ['me', 'father'];

/**
 * How the money moved. The spent section splits on this, because cash in hand
 * and money that left a bank account are tracked differently in practice.
 */
export const METHODS = ['cash', 'bank'];

const URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'fintrack';

let client = null;
let database = null;

/** Collection handles, populated by connect(). */
export const col = {};

const COLLECTIONS = [
  'users',
  'accounts',
  'categories',
  'transactions',
  'budgets',
  'goals',
  'chat_messages',
  'counters',
];

/**
 * Sequential numeric ids instead of ObjectIds. Two reasons: the REST and agent
 * contracts already speak in numbers, and a short `7` is far easier for a model
 * to read back into delete_transaction than a 24-character hex string.
 */
export async function nextId(name) {
  const res = await col.counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = res?.value ?? res;
  return doc.seq;
}

/** Mirrors the CHECK constraints the SQLite schema used to enforce. */
const typeValidator = {
  $jsonSchema: {
    bsonType: 'object',
    properties: {
      type: { enum: FLOW_TYPES },
      owner: { enum: OWNERS },
      method: { enum: [...METHODS, null] },
    },
  },
};

async function ensureCollection(name, options = {}) {
  const existing = await database.listCollections({ name }).toArray();
  if (existing.length === 0) {
    await database.createCollection(name, options);
  } else if (options.validator) {
    await database.command({ collMod: name, validator: options.validator });
  }
  col[name] = database.collection(name);
}

export async function connect() {
  if (database) return database;
  if (!URI) {
    throw new Error(
      'MONGODB_URI is not set. Add your Atlas connection string to server/.env — see .env.example.'
    );
  }

  client = new MongoClient(URI, {
    serverSelectionTimeoutMS: 10000,
    retryWrites: true,
  });
  await client.connect();
  database = client.db(DB_NAME);

  for (const name of COLLECTIONS) await ensureCollection(name);
  await ensureCollection('transactions', { validator: typeValidator });
  await ensureCollection('categories', { validator: typeValidator });

  await Promise.all([
    col.users.createIndex({ email: 1 }, { unique: true }),
    col.categories.createIndex({ user_id: 1, name: 1, type: 1 }, { unique: true }),
    col.transactions.createIndex({ user_id: 1, date: -1 }),
    col.transactions.createIndex({ user_id: 1, category: 1 }),
    col.transactions.createIndex({ user_id: 1, owner: 1, date: -1 }),
    col.budgets.createIndex({ user_id: 1, category: 1, period: 1 }, { unique: true }),
    col.goals.createIndex({ user_id: 1 }),
    col.chat_messages.createIndex({ user_id: 1, _id: 1 }),
    col.accounts.createIndex({ user_id: 1 }),
  ]);

  return database;
}

export async function close() {
  await client?.close();
  client = null;
  database = null;
}

/** Strips Mongo's `_id` into the `id` the API and UI already expect. */
export const shape = (doc) => {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
};

export const shapeAll = (docs) => docs.map(shape);

/* -------------------------------------------------------------------- seeds */

const DEFAULT_CATEGORIES = [
  ['Salary', 'income', 'briefcase'],
  ['Freelance', 'income', 'laptop'],
  ['Interest', 'income', 'percent'],
  ['Other income', 'income', 'plus'],

  ['Food & Dining', 'expense', 'utensils'],
  ['Groceries', 'expense', 'cart'],
  ['Rent', 'expense', 'home'],
  ['Transport', 'expense', 'car'],
  ['Utilities', 'expense', 'bolt'],
  ['Health', 'expense', 'heart'],
  ['Shopping', 'expense', 'bag'],
  ['Entertainment', 'expense', 'film'],
  ['Education', 'expense', 'book'],
  ['Travel', 'expense', 'plane'],
  ['Other expense', 'expense', 'tag'],

  ['Personal loan', 'borrow', 'bank'],
  ['Credit card', 'borrow', 'card'],
  ['From family or friends', 'borrow', 'people'],
  ['Other borrowing', 'borrow', 'tag'],

  ['Mutual fund / SIP', 'invest', 'chart'],
  ['Stocks', 'invest', 'chart'],
  ['Gold', 'invest', 'gold'],
  ['Fixed deposit', 'invest', 'bank'],
  ['Insurance / LIC', 'invest', 'shield'],
  ['Property', 'invest', 'home'],
  ['Other investment', 'invest', 'tag'],

  ['Lent to family or friends', 'lend', 'people'],
  ['Lent to a colleague', 'lend', 'people'],
  ['Other lending', 'lend', 'tag'],

  ['Returned by family or friends', 'recover', 'people'],
  ['Returned by a colleague', 'recover', 'people'],
  ['Other recovery', 'recover', 'tag'],

  ['Loan repayment', 'repay', 'bank'],
  ['Credit card payment', 'repay', 'card'],
  ['Repay family or friends', 'repay', 'people'],
  ['Other repayment', 'repay', 'tag'],
];

/** Idempotent: the unique index makes a re-run a no-op rather than a duplicate. */
export async function seedCategories(userId) {
  for (const [name, type, icon] of DEFAULT_CATEGORIES) {
    await col.categories.updateOne(
      { user_id: userId, name, type },
      { $setOnInsert: { _id: await nextId('categories'), user_id: userId, name, type, icon } },
      { upsert: true }
    );
  }
}

export async function seedDefaults(userId) {
  await seedCategories(userId);
  for (const [name, kind] of [['Cash', 'cash'], ['Bank', 'bank']]) {
    await col.accounts.updateOne(
      { user_id: userId, name },
      { $setOnInsert: { _id: await nextId('accounts'), user_id: userId, name, kind, archived: 0 } },
      { upsert: true }
    );
  }
}

/** Gives accounts that predate the debt types their borrow/repay categories. */
export async function backfillDebtCategories() {
  const users = await col.users.find({}, { projection: { _id: 1 } }).toArray();
  for (const u of users) await seedCategories(u._id);
}

/**
 * Rows written before the ledger existed carry no owner or method. They were all
 * entered by the account holder, so 'me' is certain; 'bank' is a guess for method
 * and is easily corrected by editing the entry.
 */
export async function backfillOwnership() {
  const owner = await col.transactions.updateMany(
    { owner: { $exists: false } },
    { $set: { owner: 'me' } }
  );
  const method = await col.transactions.updateMany(
    { method: { $exists: false } },
    { $set: { method: 'bank' } }
  );
  if (owner.modifiedCount || method.modifiedCount) {
    console.log(
      `[db] backfilled ${owner.modifiedCount} owner and ${method.modifiedCount} method fields`
    );
  }
}
