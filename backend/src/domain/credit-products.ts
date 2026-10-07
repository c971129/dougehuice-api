import type { CreditProduct } from "./models.js";

/** Lifetime pack grants this many ledger credits; clients display it as 不限次数. */
export const LIFETIME_CREDIT_AMOUNT = 999_999;
export const LIFETIME_CREDIT_PRODUCT_ID = "ai-lifetime";

export const BUILTIN_CREDIT_PRODUCTS: readonly CreditProduct[] = [
  { id: "ai-9", version: 1, name: "9 次", description: "轻量体验包", creditAmount: 9, amountCents: 390, currency: "CNY", enabled: true },
  { id: "ai-49", version: 1, name: "49 次", description: "最受欢迎", creditAmount: 49, amountCents: 1_990, currency: "CNY", enabled: true },
  { id: "ai-99", version: 1, name: "99 次", description: "创作者包", creditAmount: 99, amountCents: 3_990, currency: "CNY", enabled: true },
  {
    id: LIFETIME_CREDIT_PRODUCT_ID,
    version: 1,
    name: "不限次数",
    description: "终身会员",
    creditAmount: LIFETIME_CREDIT_AMOUNT,
    amountCents: 19_900,
    currency: "CNY",
    enabled: true,
  },
];
