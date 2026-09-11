import { Router } from 'express';
import { requireAuth, registerUser, loginUser } from '../auth.js';
import * as fin from '../finance.js';

const router = Router();

/**
 * Wraps an async handler so a resolved value becomes the JSON body and a thrown
 * error becomes a clean status. Every store call is async now, so this has to
 * await rather than inspect a return value synchronously.
 */
const handle = (fn) => async (req, res, next) => {
  try {
    const result = await fn(req, res);
    if (result !== undefined && !res.headersSent) res.json(result);
  } catch (err) {
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.message || 'Server error' });
  }
};

const id = (req) => Number(req.params.id);

/* ---------------------------------------------------------------------- auth */

router.post('/auth/register', handle(async (req) => {
  const { email, name, password, currency } = req.body || {};
  if (!email || !name || !password) {
    const err = new Error('Name, email and password are all required');
    err.status = 400;
    throw err;
  }
  if (String(password).length < 8) {
    const err = new Error('Password must be at least 8 characters');
    err.status = 400;
    throw err;
  }
  return registerUser({ email, name, password, currency });
}));

router.post('/auth/login', handle((req) => loginUser(req.body || {})));

router.get('/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

/* -------------------------------------------------------------- transactions */

router.get('/transactions', requireAuth, handle(async (req) => ({
  transactions: await fin.listTransactions(req.user.id, req.query),
})));

router.post('/transactions', requireAuth, handle(async (req) => ({
  transaction: await fin.addTransaction(req.user.id, req.body || {}),
})));

router.patch('/transactions/:id', requireAuth, handle(async (req, res) => {
  const updated = await fin.updateTransaction(req.user.id, id(req), req.body || {});
  if (!updated) return res.status(404).json({ error: 'Transaction not found' });
  return { transaction: updated };
}));

router.delete('/transactions/:id', requireAuth, handle(async (req, res) => {
  if (!(await fin.deleteTransaction(req.user.id, id(req)))) {
    return res.status(404).json({ error: 'Transaction not found' });
  }
  return { ok: true };
}));

/* ----------------------------------------------------------------- analytics */

router.get('/analytics/summary', requireAuth, handle((req) => fin.summary(req.user.id, req.query)));

router.get('/analytics/by-category', requireAuth, handle(async (req) => ({
  categories: await fin.byCategory(req.user.id, req.query),
})));

router.get('/analytics/trend', requireAuth, handle(async (req) => ({
  months: await fin.monthlyTrend(req.user.id, req.query.months),
})));

/** Daily series for the overview chart, with the periods the pickers offer. */
router.get('/analytics/series', requireAuth, handle(async (req) => {
  const [series, periods] = await Promise.all([
    fin.spendSeries(req.user.id, req.query),
    fin.seriesPeriods(req.user.id),
  ]);
  return { ...series, periods };
}));

/** Everything the dashboard needs, in one round-trip. */
router.get('/analytics/dashboard', requireAuth, handle(async (req) => {
  const [summary, byCategory, trend, budgets, goals, recent] = await Promise.all([
    fin.summary(req.user.id, req.query),
    fin.byCategory(req.user.id, req.query),
    fin.monthlyTrend(req.user.id, 6),
    fin.listBudgets(req.user.id, req.query.month),
    fin.listGoals(req.user.id),
    fin.listTransactions(req.user.id, { limit: 8 }),
  ]);
  return { summary, byCategory, trend, budgets, goals, recent };
}));

/* -------------------------------------------------------------------- hisaab */

/** The ledger page: one month, both owners, plus the month list for the picker. */
router.get('/hisaab', requireAuth, handle(async (req) => {
  const [ledger, months] = await Promise.all([
    fin.hisaab(req.user.id, req.query.month),
    fin.hisaabMonths(req.user.id),
  ]);
  return { ...ledger, months };
}));

router.get('/hisaab/months', requireAuth, handle(async (req) => ({
  months: await fin.hisaabMonths(req.user.id),
})));

/* ------------------------------------------------------------------- budgets */

router.get('/budgets', requireAuth, handle(async (req) => ({
  budgets: await fin.listBudgets(req.user.id, req.query.month),
})));

router.post('/budgets', requireAuth, handle(async (req) => ({
  budget: await fin.setBudget(req.user.id, req.body || {}),
})));

router.delete('/budgets/:id', requireAuth, handle(async (req, res) => {
  if (!(await fin.deleteBudget(req.user.id, id(req)))) {
    return res.status(404).json({ error: 'Budget not found' });
  }
  return { ok: true };
}));

/* --------------------------------------------------------------------- goals */

router.get('/goals', requireAuth, handle(async (req) => ({ goals: await fin.listGoals(req.user.id) })));

router.post('/goals', requireAuth, handle(async (req) => ({
  goal: await fin.addGoal(req.user.id, req.body || {}),
})));

router.patch('/goals/:id', requireAuth, handle(async (req, res) => {
  const goal = await fin.updateGoal(req.user.id, id(req), req.body || {});
  if (!goal) return res.status(404).json({ error: 'Goal not found' });
  return { goal };
}));

router.post('/goals/:id/contribute', requireAuth, handle(async (req, res) => {
  const goal = await fin.contributeToGoal(req.user.id, id(req), Number(req.body?.amount));
  if (!goal) return res.status(404).json({ error: 'Goal not found' });
  return { goal };
}));

router.delete('/goals/:id', requireAuth, handle(async (req, res) => {
  if (!(await fin.deleteGoal(req.user.id, id(req)))) {
    return res.status(404).json({ error: 'Goal not found' });
  }
  return { ok: true };
}));

/* ---------------------------------------------------------- categories, etc. */

router.get('/categories', requireAuth, handle(async (req) => {
  const [categories, accounts] = await Promise.all([
    fin.listCategories(req.user.id),
    fin.listAccounts(req.user.id),
  ]);
  return { categories, accounts };
}));

router.post('/categories', requireAuth, handle(async (req) => ({
  categories: await fin.addCategory(req.user.id, req.body || {}),
})));

router.delete('/categories/:id', requireAuth, handle(async (req, res) => {
  if (!(await fin.deleteCategory(req.user.id, id(req)))) {
    return res.status(404).json({ error: 'Category not found' });
  }
  return { ok: true };
}));

export default router;
