import { col, nextId, shape, shapeAll, FLOW_TYPES } from './db.js';

/* ------------------------------------------------------------------ helpers */

const today = () => new Date().toISOString().slice(0, 10);

/** Accepts 'YYYY-MM-DD', 'today', 'yesterday', or anything Date can parse. */
export function normalizeDate(value) {
  if (!value) return today();
  const raw = String(value).trim().toLowerCase();
  if (raw === 'today') return today();
  if (raw === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return today();
  return parsed.toISOString().slice(0, 10);
}

/** Inclusive month bounds for 'YYYY-MM'; defaults to the current month. */
export function monthRange(month) {
  const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : today().slice(0, 7);
  const [y, mo] = m.split('-').map(Number);
  const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  return { month: m, from: `${m}-01`, to: end };
}

function round(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Dates are stored as 'YYYY-MM-DD' strings, which sort and range correctly. */
const inRange = (from, to) => ({ date: { $gte: from, $lte: to } });

/** Case-insensitive exact match without a regex injection surface. */
const ciExact = (value) => ({ $regex: `^${escapeRegex(value)}$`, $options: 'i' });
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeType = (value) => (FLOW_TYPES.includes(value) ? value : 'expense');

const FALLBACK_CATEGORY = {
  income: 'Other income',
  expense: 'Other expense',
  borrow: 'Other borrowing',
  repay: 'Other repayment',
};

/* ------------------------------------------------------------- transactions */

export async function listTransactions(userId, filters = {}) {
  const { from, to, type, category, search, limit = 200, offset = 0 } = filters;
  const query = { user_id: userId };

  if (from || to) {
    query.date = {};
    if (from) query.date.$gte = normalizeDate(from);
    if (to) query.date.$lte = normalizeDate(to);
  }
  if (type) query.type = type;
  if (category) query.category = ciExact(category);
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    query.$or = [{ note: rx }, { category: rx }];
  }

  const docs = await col.transactions
    .find(query)
    .sort({ date: -1, _id: -1 })
    .skip(Number(offset))
    .limit(Number(limit))
    .toArray();

  return shapeAll(docs);
}

export async function addTransaction(userId, tx) {
  const type = normalizeType(tx.type);
  const amount = Number(tx.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error('Amount must be a positive number');
    err.status = 400;
    throw err;
  }

  const doc = {
    _id: await nextId('transactions'),
    user_id: userId,
    type,
    amount: round(amount),
    category: String(tx.category || FALLBACK_CATEGORY[type]).trim(),
    account: tx.account ? String(tx.account).trim() : null,
    note: tx.note ? String(tx.note).trim() : null,
    date: normalizeDate(tx.date),
    created_at: new Date().toISOString(),
  };

  await col.transactions.insertOne(doc);
  return shape(doc);
}

export async function getTransaction(userId, id) {
  return shape(await col.transactions.findOne({ _id: Number(id), user_id: userId }));
}

export async function updateTransaction(userId, id, patch) {
  const set = {};
  if (patch.type != null) set.type = normalizeType(patch.type);
  if (patch.amount != null) set.amount = round(Number(patch.amount));
  if (patch.category != null) set.category = String(patch.category).trim();
  if (patch.account !== undefined) set.account = patch.account;
  if (patch.note !== undefined) set.note = patch.note;
  if (patch.date) set.date = normalizeDate(patch.date);

  const res = await col.transactions.findOneAndUpdate(
    { _id: Number(id), user_id: userId },
    { $set: set },
    { returnDocument: 'after' }
  );
  return shape(res?.value ?? res);
}

export async function deleteTransaction(userId, id) {
  const res = await col.transactions.deleteOne({ _id: Number(id), user_id: userId });
  return res.deletedCount > 0;
}

/* ----------------------------------------------------------------- analytics */

/** One pass over the period, bucketed by flow type. */
async function totalsByType(userId, from, to) {
  const rows = await col.transactions
    .aggregate([
      { $match: { user_id: userId, ...inRange(from, to) } },
      { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ])
    .toArray();

  const out = { income: 0, expense: 0, borrow: 0, repay: 0, count: 0 };
  for (const r of rows) {
    out[r._id] = round(r.total);
    out.count += r.count;
  }
  return out;
}

export async function summary(userId, { from, to } = {}) {
  const range = from && to ? { from: normalizeDate(from), to: normalizeDate(to) } : monthRange();
  const t = await totalsByType(userId, range.from, range.to);

  // `net` deliberately ignores borrowing: money you owe is not money you kept.
  const net = round(t.income - t.expense);

  return {
    from: range.from,
    to: range.to,
    income: t.income,
    expense: t.expense,
    net,
    borrowed: t.borrow,
    repaid: t.repay,
    // How much the debt pile moved this period: positive means you took on more.
    debtDelta: round(t.borrow - t.repay),
    // What actually moved through the account, debt included.
    cashIn: round(t.income + t.borrow),
    cashOut: round(t.expense + t.repay),
    transactions: t.count,
    savingsRate: t.income > 0 ? round((net / t.income) * 100) : 0,
  };
}

export async function byCategory(userId, { from, to, type = 'expense' } = {}) {
  const range = from && to ? { from: normalizeDate(from), to: normalizeDate(to) } : monthRange();

  const rows = await col.transactions
    .aggregate([
      { $match: { user_id: userId, type, ...inRange(range.from, range.to) } },
      { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ])
    .toArray();

  const total = rows.reduce((s, r) => s + r.total, 0);
  return rows.map((r) => ({
    category: r._id,
    total: round(r.total),
    count: r.count,
    share: total > 0 ? round((r.total / total) * 100) : 0,
  }));
}

/** Income / expense / net for the last `months` calendar months, oldest first. */
export async function monthlyTrend(userId, months = 6) {
  const n = Math.min(Math.max(Number(months) || 6, 1), 24);
  const now = new Date();

  const buckets = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    buckets.push({ key: d.toISOString().slice(0, 7), label: d.toLocaleString('en', { month: 'short', timeZone: 'UTC' }) });
  }

  // One aggregation for the whole window, grouped on the YYYY-MM prefix.
  const rows = await col.transactions
    .aggregate([
      {
        $match: {
          user_id: userId,
          ...inRange(`${buckets[0].key}-01`, monthRange(buckets[buckets.length - 1].key).to),
        },
      },
      {
        $group: {
          _id: { month: { $substrBytes: ['$date', 0, 7] }, type: '$type' },
          total: { $sum: '$amount' },
        },
      },
    ])
    .toArray();

  const lookup = new Map();
  for (const r of rows) lookup.set(`${r._id.month}|${r._id.type}`, r.total);
  const at = (month, type) => round(lookup.get(`${month}|${type}`) || 0);

  return buckets.map(({ key, label }) => {
    const income = at(key, 'income');
    const expense = at(key, 'expense');
    return {
      month: key,
      label,
      income,
      expense,
      net: round(income - expense),
      borrowed: at(key, 'borrow'),
      repaid: at(key, 'repay'),
    };
  });
}

/* ------------------------------------------------------------------- budgets */

export async function listBudgets(userId, month) {
  const { from, to, month: m } = monthRange(month);
  const budgets = await col.budgets.find({ user_id: userId }).sort({ category: 1 }).toArray();
  if (budgets.length === 0) return [];

  // Spend per category for the month, in one aggregation rather than per budget.
  const rows = await col.transactions
    .aggregate([
      { $match: { user_id: userId, type: 'expense', ...inRange(from, to) } },
      { $group: { _id: { $toLower: '$category' }, spent: { $sum: '$amount' } } },
    ])
    .toArray();
  const spentBy = new Map(rows.map((r) => [r._id, r.spent]));

  return budgets.map((b) => {
    const spent = round(spentBy.get(String(b.category).toLowerCase()) || 0);
    return {
      ...shape(b),
      month: m,
      spent,
      remaining: round(b.amount - spent),
      usage: b.amount > 0 ? round((spent / b.amount) * 100) : 0,
      status: spent > b.amount ? 'over' : spent >= b.amount * 0.8 ? 'warning' : 'good',
    };
  });
}

export async function setBudget(userId, { category, amount, period = 'monthly' }) {
  const name = String(category).trim();
  await col.budgets.updateOne(
    { user_id: userId, category: name, period },
    {
      $set: { amount: round(Number(amount)) },
      $setOnInsert: { _id: await nextId('budgets'), user_id: userId, category: name, period },
    },
    { upsert: true }
  );
  const all = await listBudgets(userId);
  return all.find((b) => b.category.toLowerCase() === name.toLowerCase());
}

export async function deleteBudget(userId, id) {
  const res = await col.budgets.deleteOne({ _id: Number(id), user_id: userId });
  return res.deletedCount > 0;
}

/* --------------------------------------------------------------------- goals */

function decorateGoal(doc) {
  const g = shape(doc);
  if (!g) return null;
  const progress = g.target > 0 ? round((g.saved / g.target) * 100) : 0;
  let monthlyNeeded = null;
  if (g.deadline) {
    const now = new Date();
    const end = new Date(g.deadline);
    const monthsLeft = Math.max(
      (end.getFullYear() - now.getFullYear()) * 12 + (end.getMonth() - now.getMonth()),
      0
    );
    const remaining = Math.max(g.target - g.saved, 0);
    monthlyNeeded = monthsLeft > 0 ? round(remaining / monthsLeft) : round(remaining);
  }
  return { ...g, progress, remaining: round(Math.max(g.target - g.saved, 0)), monthlyNeeded };
}

export async function listGoals(userId) {
  const docs = await col.goals.find({ user_id: userId }).sort({ _id: -1 }).toArray();
  return docs.map(decorateGoal);
}

export async function addGoal(userId, { name, target, saved = 0, deadline = null }) {
  const doc = {
    _id: await nextId('goals'),
    user_id: userId,
    name: String(name).trim(),
    target: round(Number(target)),
    saved: round(Number(saved) || 0),
    deadline: deadline || null,
    created_at: new Date().toISOString(),
  };
  await col.goals.insertOne(doc);
  return decorateGoal(doc);
}

/** Adds `amount` to a goal's saved total (a negative amount withdraws). */
export async function contributeToGoal(userId, id, amount) {
  const goal = await col.goals.findOne({ _id: Number(id), user_id: userId });
  if (!goal) return null;
  const saved = round(Math.max(goal.saved + Number(amount), 0));
  await col.goals.updateOne({ _id: goal._id }, { $set: { saved } });
  return decorateGoal({ ...goal, saved });
}

export async function updateGoal(userId, id, patch) {
  const set = {};
  if (patch.name != null) set.name = String(patch.name).trim();
  if (patch.target != null) set.target = round(Number(patch.target));
  if (patch.saved != null) set.saved = round(Number(patch.saved));
  if (patch.deadline !== undefined) set.deadline = patch.deadline;

  const res = await col.goals.findOneAndUpdate(
    { _id: Number(id), user_id: userId },
    { $set: set },
    { returnDocument: 'after' }
  );
  return decorateGoal(res?.value ?? res);
}

export async function deleteGoal(userId, id) {
  const res = await col.goals.deleteOne({ _id: Number(id), user_id: userId });
  return res.deletedCount > 0;
}

/* ---------------------------------------------------------------- categories */

export async function listCategories(userId) {
  const docs = await col.categories.find({ user_id: userId }).sort({ type: 1, name: 1 }).toArray();
  return shapeAll(docs);
}

export async function addCategory(userId, { name, type, icon = 'tag' }) {
  const clean = String(name).trim();
  const flow = normalizeType(type);
  await col.categories.updateOne(
    { user_id: userId, name: clean, type: flow },
    { $setOnInsert: { _id: await nextId('categories'), user_id: userId, name: clean, type: flow, icon } },
    { upsert: true }
  );
  return listCategories(userId);
}

export async function deleteCategory(userId, id) {
  const res = await col.categories.deleteOne({ _id: Number(id), user_id: userId });
  return res.deletedCount > 0;
}

export async function listAccounts(userId) {
  const docs = await col.accounts.find({ user_id: userId, archived: 0 }).sort({ name: 1 }).toArray();
  return shapeAll(docs);
}
