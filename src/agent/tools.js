import { z } from 'zod';
import * as fin from '../finance.js';
import { FLOW_TYPES, OWNERS, METHODS } from '../db.js';

const dateHint = "Date as YYYY-MM-DD, or 'today' / 'yesterday'.";

/**
 * Provider-neutral tool definitions: a name, a description, a zod input schema
 * and a plain function. Provider adapters in ./providers/ translate these into
 * whatever shape their SDK wants — nothing in here knows about Claude or Gemini.
 */
const DEFINITIONS = [
  {
    name: 'add_transaction',
    description:
      'Record money moving. Seven types. "income" (earned) and "expense" (spent and gone) are the ' +
      'everyday two. "invest" is money put into a mutual fund, SIP, stocks, gold, FD or property — it ' +
      'leaves the purse but is still theirs. The other four move money between them and other people: ' +
      '"borrow" (someone hands them money they must pay back), "repay" (they hand it back), "lend" ' +
      '(they hand someone money that person will return — "gave 2000 to Abhinav") and "recover" (that ' +
      'person returns it, in full or in part). Only "expense" is spending: borrowing is not income, ' +
      'lending is not an expense, and a recovery is not income. Every entry belongs to an owner — ' +
      '"me" or "father" — and money out is either cash or bank/UPI. Pick the closest category listed ' +
      'in the context for that same flow type.',
    schema: z.object({
      type: z.enum(FLOW_TYPES).describe('income | expense | invest | borrow | repay | lend | recover'),
      amount: z.number().positive().describe('Positive amount in the user currency'),
      category: z.string().describe('Category name, e.g. "Groceries"'),
      owner: z
        .enum(OWNERS)
        .optional()
        .describe("Whose money: 'father' when the user says father's / papa's / dad's money, else 'me'"),
      method: z
        .enum(METHODS)
        .optional()
        .describe("How it moved: 'cash' for notes in hand, 'bank' for UPI, card or transfer"),
      date: z.string().optional().describe(dateHint),
      note: z.string().optional().describe('Short description of the transaction'),
      account: z.string().optional().describe('Account name, e.g. "Cash" or "Bank"'),
    }),
    run: (userId, input) => fin.addTransaction(userId, input),
  },
  {
    name: 'list_transactions',
    description:
      'List the user transactions, newest first, with optional filters. Use this before answering ' +
      'questions about specific purchases or when the user asks "what did I spend on X".',
    schema: z.object({
      from: z.string().optional().describe(dateHint),
      to: z.string().optional().describe(dateHint),
      type: z.enum(FLOW_TYPES).optional(),
      owner: z.enum(OWNERS).optional().describe("Restrict to one purse: 'me' or 'father'"),
      method: z.enum(METHODS).optional().describe("Restrict to 'cash' or 'bank'"),
      category: z.string().optional(),
      search: z.string().optional().describe('Free-text match against note and category'),
      limit: z.number().int().min(1).max(100).optional().describe('Defaults to 25'),
    }),
    run: (userId, input) => fin.listTransactions(userId, { limit: 25, ...input }),
  },
  {
    name: 'update_transaction',
    description: 'Correct an existing transaction. Confirm the id with list_transactions first.',
    schema: z.object({
      id: z.number().int(),
      type: z.enum(FLOW_TYPES).optional(),
      amount: z.number().positive().optional(),
      category: z.string().optional(),
      owner: z.enum(OWNERS).optional(),
      method: z.enum(METHODS).optional(),
      date: z.string().optional().describe(dateHint),
      note: z.string().optional(),
    }),
    run: (userId, { id, ...patch }) =>
      fin.updateTransaction(userId, id, patch) ?? { error: `No transaction with id ${id}` },
  },
  {
    name: 'delete_transaction',
    description:
      'Delete a transaction permanently. Only call this when the user has clearly asked to remove ' +
      'a specific entry, and state which one you deleted in your reply.',
    schema: z.object({ id: z.number().int() }),
    run: (userId, { id }) =>
      fin.deleteTransaction(userId, id) ? { deleted: id } : { error: `No transaction with id ${id}` },
  },
  {
    name: 'get_summary',
    description:
      'Totals for a period: income, expense, net, savings rate, plus borrowed, repaid and debtDelta ' +
      '(borrowed minus repaid — positive means the user took on more debt). Defaults to the current ' +
      'month. Start here for any "how am I doing" question.',
    schema: z.object({
      from: z.string().optional().describe(dateHint),
      to: z.string().optional().describe(dateHint),
    }),
    run: (userId, input) => fin.summary(userId, input),
  },
  {
    name: 'spending_by_category',
    description: 'Break a period down by category, largest first, with each share of the total.',
    schema: z.object({
      from: z.string().optional().describe(dateHint),
      to: z.string().optional().describe(dateHint),
      type: z.enum(FLOW_TYPES).optional().describe("Defaults to 'expense'. Use 'borrow' or 'repay' to break down debt."),
    }),
    run: (userId, input) => fin.byCategory(userId, { type: 'expense', ...input }),
  },
  {
    name: 'monthly_trend',
    description: 'Income, expense and net per calendar month for the last N months. Use for trend questions.',
    schema: z.object({
      months: z.number().int().min(1).max(24).optional().describe('Defaults to 6'),
    }),
    run: (userId, { months }) => fin.monthlyTrend(userId, months ?? 6),
  },
  {
    name: 'get_hisaab',
    description:
      "The hisaab ledger for one month: income, spent (split cash vs bank/UPI), invested, the credit " +
      'position and the running balance, reported separately for "me" and "father". Use this for any ' +
      "question about whose money it is, what is left, who owes whom, or father's side of the " +
      'accounts. Per owner it returns owedToMe (their money still out with other people), owedByMe ' +
      '(money they are holding that belongs to others) and creditBalance (owedByMe minus owedToMe, so ' +
      'negative means they are owed). Balance is cumulative to the end of that month.',
    schema: z.object({
      month: z.string().optional().describe('YYYY-MM; defaults to the current month'),
    }),
    run: (userId, { month }) => fin.hisaab(userId, month),
  },
  {
    name: 'list_hisaab_months',
    description: 'Which months have entries, newest first. Use before asking about an older month.',
    schema: z.object({}),
    run: (userId) => fin.hisaabMonths(userId),
  },
  {
    name: 'list_budgets',
    description: 'Monthly budgets with spent, remaining and status (good / warning / over) for a month.',
    schema: z.object({ month: z.string().optional().describe('YYYY-MM; defaults to this month') }),
    run: (userId, { month }) => fin.listBudgets(userId, month),
  },
  {
    name: 'set_budget',
    description: 'Create or update the monthly budget for a category.',
    schema: z.object({ category: z.string(), amount: z.number().positive() }),
    run: (userId, input) => fin.setBudget(userId, input),
  },
  {
    name: 'list_goals',
    description: 'Savings goals with progress, amount remaining and the monthly contribution needed.',
    schema: z.object({}),
    run: (userId) => fin.listGoals(userId),
  },
  {
    name: 'create_goal',
    description: 'Create a savings goal.',
    schema: z.object({
      name: z.string(),
      target: z.number().positive(),
      saved: z.number().min(0).optional(),
      deadline: z.string().optional().describe('Target date as YYYY-MM-DD'),
    }),
    run: (userId, input) => fin.addGoal(userId, input),
  },
  {
    name: 'contribute_to_goal',
    description: 'Add money to a savings goal (use a negative amount to withdraw).',
    schema: z.object({ id: z.number().int(), amount: z.number() }),
    run: (userId, { id, amount }) =>
      fin.contributeToGoal(userId, id, amount) ?? { error: `No goal with id ${id}` },
  },
  {
    name: 'list_categories',
    description:
      'The categories available to this user. Call this before creating a transaction with an unfamiliar category.',
    schema: z.object({}),
    run: (userId) => fin.listCategories(userId),
  },
];

/** Tools whose names imply a write — used to decide when the UI should refetch. */
export const WRITE_TOOLS = new Set([
  'add_transaction',
  'update_transaction',
  'delete_transaction',
  'set_budget',
  'create_goal',
  'contribute_to_goal',
]);

/**
 * Binds the toolset to one user. Every `run` closes over `userId`, so the model
 * cannot reach another account's rows even if it invents an id.
 *
 * `onEvent` reports each call so the UI can show what the agent did.
 */
export function buildTools(userId, onEvent = () => {}) {
  return DEFINITIONS.map((def) => ({
    name: def.name,
    description: def.description,
    schema: def.schema,
    /** Always resolves to a JSON string — a thrown tool error would kill the turn. */
    run: async (input = {}) => {
      onEvent({ type: 'tool', name: def.name, input });
      try {
        return JSON.stringify((await def.run(userId, input)) ?? { ok: true });
      } catch (err) {
        return JSON.stringify({ error: err.message || 'Tool failed' });
      }
    },
  }));
}
