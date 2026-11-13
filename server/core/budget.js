'use strict';

function createBudget(limit, fallback) {
  const parsed = Number(limit);
  const fallbackNumber = Number(fallback);
  const max =
    Number.isFinite(parsed) && parsed >= 0
      ? Math.floor(parsed)
      : Number.isFinite(fallbackNumber) && fallbackNumber >= 0
        ? Math.floor(fallbackNumber)
        : 0;
  return {
    limit: max,
    used: 0,
    get remaining() {
      return Math.max(max - this.used, 0);
    },
    take() {
      if (this.used >= max) return false;
      this.used++;
      return true;
    },
  };
}

function budgetLimitFromEnv(envName, fallback) {
  const raw = Number(process.env[envName]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

function budgetFromEnv(envName, fallback) {
  return createBudget(budgetLimitFromEnv(envName, fallback), fallback);
}

function usedOf(budget) {
  if (!budget) return null;
  return Number.isFinite(Number(budget.used)) ? Number(budget.used) : null;
}

function budgetRefused(budget, usedBefore) {
  if (!budget) return false;
  const before = usedBefore == null ? null : Number(usedBefore);
  return before != null && usedOf(budget) === before && Number(budget.remaining) === 0;
}

module.exports = {
  createBudget,
  budgetLimitFromEnv,
  budgetFromEnv,
  usedOf,
  budgetRefused,
};
