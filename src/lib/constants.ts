// Shared "enum-like" values (kept as strings for SQLite portability) + labels.

export const FIXED_COST_CATEGORIES = [
  "SHOPIFY",
  "KLAVIYO",
  "LINE",
  "FACILITY",
  "OTHER",
] as const;
export type FixedCostCategory = (typeof FIXED_COST_CATEGORIES)[number];

export const FIXED_COST_CATEGORY_LABELS: Record<string, string> = {
  SHOPIFY: "Shopify",
  KLAVIYO: "Klaviyo",
  LINE: "Line Tools / Official",
  FACILITY: "Chi phí cơ sở",
  OTHER: "Khác",
};

export const BILLING_CYCLES = ["MONTHLY", "YEARLY", "ONE_TIME"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const BILLING_CYCLE_LABELS: Record<string, string> = {
  MONTHLY: "Hàng tháng",
  YEARLY: "Hàng năm",
  ONE_TIME: "Một lần",
};

export const COST_RULE_TYPES = [
  "COGS",
  "SELLING_FEE",
  "SHIPPING",
  "INK",
  "PERSONNEL",
  "PACKAGING",
  "OTHER",
] as const;
export type CostRuleType = (typeof COST_RULE_TYPES)[number];

export const COST_RULE_TYPE_LABELS: Record<string, string> = {
  COGS: "COGS (Basecost)",
  SELLING_FEE: "Phí bán hàng",
  SHIPPING: "Phí vận chuyển",
  INK: "Phí mực in",
  PERSONNEL: "Phí nhân sự",
  PACKAGING: "Đóng gói",
  OTHER: "Khác",
};

export const CALC_METHODS = [
  "PER_UNIT",
  "PER_ORDER",
  "PERCENT_OF_REVENUE",
] as const;
export type CalcMethod = (typeof CALC_METHODS)[number];

export const CALC_METHOD_LABELS: Record<string, string> = {
  PER_UNIT: "Theo sản phẩm (mỗi cái)",
  PER_ORDER: "Theo đơn hàng",
  PERCENT_OF_REVENUE: "% Doanh thu",
};

export const AD_PLATFORMS = ["FACEBOOK", "GOOGLE", "TWITTER", "OTHER"] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

export const AD_PLATFORM_LABELS: Record<string, string> = {
  FACEBOOK: "Facebook / Meta",
  GOOGLE: "Google",
  TWITTER: "Twitter / X",
  OTHER: "Khác",
};

// Traffic source / attribution channel of an order (derived from Shopify UTM).
export const ORDER_CHANNELS = [
  "FACEBOOK",
  "GOOGLE",
  "TWITTER",
  "KLAVIYO",
  "DIRECT",
  "ORGANIC",
  "REFERRAL",
  "OTHER",
] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

export const ORDER_CHANNEL_LABELS: Record<string, string> = {
  FACEBOOK: "Facebook / Meta",
  GOOGLE: "Google",
  TWITTER: "Twitter / X",
  KLAVIYO: "Klaviyo (Email)",
  DIRECT: "Trực tiếp",
  ORGANIC: "Tìm kiếm tự nhiên",
  REFERRAL: "Giới thiệu",
  OTHER: "Khác / Chưa rõ",
};

/** Channels that map to a paid ad platform (for ROAS pairing in Phase 3). */
export const CHANNEL_TO_AD_PLATFORM: Record<string, string> = {
  FACEBOOK: "FACEBOOK",
  GOOGLE: "GOOGLE",
  TWITTER: "TWITTER",
};
