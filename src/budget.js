// Per-user daily cost cap. Pure-SQL implementation against the turns
// audit log — no extra state to maintain, no clock drift, no in-memory
// counter that can fall out of sync after a restart. Off by default;
// turning it on means setting DAILY_USER_COST_CAP_USD to a positive
// number in the env.
//
// The "day" boundary is midnight UTC: a fixed, time-zone-independent
// reset. A trader in NY sees the budget refresh at 8 PM ET in winter
// (7 PM EDT in summer), which is a reasonable trade-off against
// time-zone bookkeeping.

import { config } from './config.js';
import { userSpendSince } from './memory.js';

function startOfUtcDay(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function isBudgetEnabled() {
  return config.budget.dailyUserCapUsd > 0;
}

export function checkBudget(userId) {
  if (!isBudgetEnabled()) {
    return { allowed: true, cap: null, spent: 0, remaining: null };
  }
  const dayStart = startOfUtcDay();
  const spent = userSpendSince(userId, dayStart);
  const cap = config.budget.dailyUserCapUsd;
  const remaining = +(cap - spent).toFixed(4);
  const allowed = spent < cap;
  const msUntilReset = startOfUtcDay() + 24 * 3600 * 1000 - Date.now();
  return {
    allowed,
    cap,
    spent: +spent.toFixed(4),
    remaining: allowed ? remaining : 0,
    reset_in_seconds: Math.ceil(msUntilReset / 1000),
  };
}
