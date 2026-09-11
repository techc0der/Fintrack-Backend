import { col, nextId, shape, shapeAll, FLOW_TYPES, OWNERS, METHODS } from './db.js';

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

/** Unrecognised owner falls back to 'me' — never silently to someone else's purse. */
const normalizeOwner = (value) => (OWNERS.includes(value) ? value : 'me');

/** 'upi' is the everyday word for it, but it settles out of a bank account. */
const normalizeMethod = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'upi' || raw === 'card' || raw === 'online' || raw === 'bank') return 'bank';
  if (raw === 'cash') return 'cash';
  return METHODS.includes(raw) ? raw : 'bank';
};

const FALLBACK_CATEGORY = {
  income: 'Other income',
  expense: 'Other expense',
  borrow: 'Other borrowing',
  repay: 'Other repayment',
  invest: 'Other investment',
  lend: 'Other lending',
  recover: 'Other recovery',
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
  if (filters.owner) query.owner = normalizeOwner(filters.owner);
  if (filters.method) query.method = normalizeMethod(filters.method);
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
    owner: normalizeOwner(tx.owner),
    method: normalizeMethod(tx.method),
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
  if (patch.owner != null) set.owner = normalizeOwner(patch.owner);
  if (patch.method != null) set.method = normalizeMethod(patch.method);
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

  const out = {
    income: 0, expense: 0, invest: 0,
    borrow: 0, repay: 0, lend: 0, recover: 0,
    count: 0,
  };
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
    cashIn: round(t.income + t.borrow + t.recover),
    invested: t.invest,
    lent: t.lend,
    recovered: t.recover,
    cashOut: round(t.expense + t.repay + t.invest + t.lend),
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

/* ------------------------------------------------------------------- hisaab */

/**
 * The hisaab ledger: one month's money, kept separately for each owner.
 *
 * Four sections, in the order the arithmetic runs:
 *
 *   1. income      what came in this month
 *   2. spent       what went out, split cash vs UPI/bank
 *   3. invested    money that left the purse but is still yours
 *   4. balance     everything ever in, minus everything ever out, as at month end
 *
 * Balance is cumulative rather than monthly — it answers "what is actually left",
 * so it carries forward across months. Borrowing is included because borrowed
 * money really is in your hand; it is reported separately so the figure can be
 * read either way.
 */
export async function hisaab(userId, month) {
  const { month: m, from, to } = monthRange(month);

  const ownerField = { $ifNull: ['$owner', 'me'] };
  const methodField = { $ifNull: ['$method', 'bank'] };

  const [thisMonth, toDate] = await Promise.all([
    // This month, split by owner, type and payment method.
    col.transactions
      .aggregate([
        { $match: { user_id: userId, ...inRange(from, to) } },
        {
          $group: {
            _id: { owner: ownerField, type: '$type', method: methodField },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray(),

    // Everything up to and including the last day of this month, for the balance.
    col.transactions
      .aggregate([
        { $match: { user_id: userId, date: { $lte: to } } },
        {
          $group: {
            _id: { owner: ownerField, type: '$type' },
            total: { $sum: '$amount' },
          },
        },
      ])
      .toArray(),
  ]);

  const blank = () => ({
    income: 0,
    spent: { cash: 0, bank: 0, total: 0 },
    invested: 0,
    borrowed: 0,
    repaid: 0,
    lent: 0,
    recovered: 0,
    entries: 0,
    lifetime: { income: 0, expense: 0, invest: 0, borrow: 0, repay: 0, lend: 0, recover: 0 },
  });

  const owners = { me: blank(), father: blank() };

  for (const row of thisMonth) {
    const o = owners[row._id.owner] ?? owners.me;
    const amount = round(row.total);
    o.entries += row.count;

    if (row._id.type === 'income') o.income = round(o.income + amount);
    else if (row._id.type === 'invest') o.invested = round(o.invested + amount);
    else if (row._id.type === 'borrow') o.borrowed = round(o.borrowed + amount);
    else if (row._id.type === 'repay') o.repaid = round(o.repaid + amount);
    else if (row._id.type === 'lend') o.lent = round(o.lent + amount);
    else if (row._id.type === 'recover') o.recovered = round(o.recovered + amount);
    else if (row._id.type === 'expense') {
      o.spent[row._id.method] = round(o.spent[row._id.method] + amount);
      o.spent.total = round(o.spent.cash + o.spent.bank);
    }
  }

  for (const row of toDate) {
    const o = owners[row._id.owner] ?? owners.me;
    o.lifetime[row._id.type] = round(row.total);
  }

  for (const o of Object.values(owners)) {
    const l = o.lifetime;

    // This month's net movement with other people. Money handed to you counts
    // positive, money you hand over counts negative — so a single signed figure
    // says which way you are out of pocket.
    o.creditFlow = round(o.borrowed + o.recovered - o.lent - o.repaid);

    // The standing position, all months together.
    o.owedByMe = round(l.borrow - l.repay);      // their money, in your hands
    o.owedToMe = round(l.lend - l.recover);      // your money, in theirs
    o.creditBalance = round(o.owedByMe - o.owedToMe);

    // Everything ever received, less everything ever paid out or locked away.
    o.balance = round(
      l.income + l.borrow + l.recover - l.expense - l.repay - l.lend - l.invest
    );

    // Where that balance stood before this month's entries.
    o.opening = round(
      o.balance - (o.income - o.spent.total - o.invested + o.creditFlow)
    );

    // The user's own shorthand, for when nothing is owed in either direction.
    o.simpleBalance = round(l.income - l.expense - l.invest);
  }

  const sum = (pick) => round(pick(owners.me) + pick(owners.father));

  return {
    month: m,
    from,
    to,
    label: new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }),
    isCurrent: m === today().slice(0, 7),
    owners,
    total: {
      income: sum((o) => o.income),
      spent: {
        cash: sum((o) => o.spent.cash),
        bank: sum((o) => o.spent.bank),
        total: sum((o) => o.spent.total),
      },
      invested: sum((o) => o.invested),
      borrowed: sum((o) => o.borrowed),
      repaid: sum((o) => o.repaid),
      lent: sum((o) => o.lent),
      recovered: sum((o) => o.recovered),
      creditFlow: sum((o) => o.creditFlow),
      creditBalance: sum((o) => o.creditBalance),
      owedByMe: sum((o) => o.owedByMe),
      owedToMe: sum((o) => o.owedToMe),
      balance: sum((o) => o.balance),
      opening: sum((o) => o.opening),
      entries: sum((o) => o.entries),
    },
  };
}

/**
 * Months that have any activity, newest first, for the ledger's picker. The
 * current month is always included even when empty, so the page has somewhere
 * to land on a fresh account.
 */
export async function hisaabMonths(userId) {
  const rows = await col.transactions
    .aggregate([
      { $match: { user_id: userId } },
      { $group: { _id: { $substrBytes: ['$date', 0, 7] } } },
      { $sort: { _id: -1 } },
    ])
    .toArray();

  const months = rows.map((r) => r._id);
  const current = today().slice(0, 7);
  if (!months.includes(current)) months.unshift(current);

  return months.map((m) => ({
    month: m,
    label: new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }),
    isCurrent: m === current,
  }));
}

/* -------------------------------------------------------------- overview series */

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Every date from `from` to `to` inclusive, as 'YYYY-MM-DD'. */
function eachDay(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const pctChange = (current, previous) => {
  if (!previous) return null;
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
  return Math.abs(pct) > 999 ? null : pct;
};

/**
 * A daily series for the overview chart, plus the groups the chart highlights.
 *
 *   granularity 'year'  -> one bar per day of the year, grouped by month
 *   granularity 'month' -> one bar per day of the month, each day its own group
 *
 * Days with no activity are returned as zeros rather than omitted, so the bars
 * stay on a real time axis instead of bunching up wherever money happened to move.
 */
export async function spendSeries(userId, { granularity = 'year', period, type = 'expense' } = {}) {
  const byYear = granularity !== 'month';
  const now = today();

  const year = /^\d{4}$/.test(String(period || '')) ? String(period) : now.slice(0, 4);
  const month = /^\d{4}-\d{2}$/.test(String(period || '')) ? period : now.slice(0, 7);

  const range = byYear
    ? { from: `${year}-01-01`, to: `${year}-12-31`, key: year, label: year }
    : { ...monthRange(month), key: month, label: `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}` };

  const rows = await col.transactions
    .aggregate([
      { $match: { user_id: userId, type, ...inRange(range.from, range.to) } },
      { $group: { _id: '$date', total: { $sum: '$amount' } } },
    ])
    .toArray();

  const totals = new Map(rows.map((r) => [r._id, r.total]));
  const days = eachDay(range.from, range.to);
  const points = days.map((date) => ({ date, value: round(totals.get(date) || 0) }));

  // Groups: a month of days when viewing a year, a single day when viewing a month.
  const groups = [];
  if (byYear) {
    for (let m = 0; m < 12; m++) {
      const key = `${year}-${String(m + 1).padStart(2, '0')}`;
      const startIndex = points.findIndex((p) => p.date.startsWith(key));
      const slice = points.filter((p) => p.date.startsWith(key));
      groups.push({
        key,
        label: `${MONTH_NAMES[m]} ${year}`,
        short: MONTH_NAMES[m],
        startIndex: startIndex === -1 ? 0 : startIndex,
        count: slice.length,
        total: round(slice.reduce((s, p) => s + p.value, 0)),
      });
    }
  } else {
    points.forEach((p, i) => {
      const d = Number(p.date.slice(8, 10));
      groups.push({
        key: p.date,
        label: `${d} ${range.label}`,
        short: String(d),
        startIndex: i,
        count: 1,
        total: p.value,
      });
    });
  }

  // Each group against the one before it — the delta the tooltip shows.
  groups.forEach((g, i) => {
    g.changePercent = i > 0 ? pctChange(g.total, groups[i - 1].total) : null;
  });

  const total = round(points.reduce((s, p) => s + p.value, 0));

  // The same window a year or a month earlier, for the headline comparison.
  const prevKey = byYear
    ? String(Number(year) - 1)
    : new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  const prevRange = byYear
    ? { from: `${prevKey}-01-01`, to: `${prevKey}-12-31` }
    : monthRange(prevKey);
  const prevRow = await col.transactions
    .aggregate([
      { $match: { user_id: userId, type, ...inRange(prevRange.from, prevRange.to) } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ])
    .toArray();
  const previousTotal = round(prevRow[0]?.total || 0);

  return {
    granularity: byYear ? 'year' : 'month',
    period: range.key,
    label: range.label,
    type,
    from: range.from,
    to: range.to,
    total,
    previousTotal,
    changePercent: pctChange(total, previousTotal),
    points,
    groups,
  };
}

/** Which years and months actually have entries, for the overview pickers. */
export async function seriesPeriods(userId) {
  const rows = await col.transactions
    .aggregate([
      { $match: { user_id: userId } },
      { $group: { _id: { $substrBytes: ['$date', 0, 7] } } },
      { $sort: { _id: -1 } },
    ])
    .toArray();

  const months = rows.map((r) => r._id);
  const nowMonth = today().slice(0, 7);
  if (!months.includes(nowMonth)) months.unshift(nowMonth);
  months.sort().reverse();

  const years = [...new Set(months.map((m) => m.slice(0, 4)))].sort().reverse();

  return {
    years: years.map((y) => ({ value: y, label: y })),
    months: months.map((m) => ({
      value: m,
      label: `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`,
    })),
  };
}
