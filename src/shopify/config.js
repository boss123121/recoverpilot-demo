const DEFAULT_SCOPES = [
  "read_orders",
  "read_customers"
];

function readShopifyConfig() {
  const appUrl = process.env.SHOPIFY_APP_URL || `http://localhost:${process.env.PORT || 3000}`;

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    apiSecret: process.env.SHOPIFY_API_SECRET || "",
    appUrl: appUrl.replace(/\/$/, ""),
    scopes: (process.env.SHOPIFY_SCOPES || DEFAULT_SCOPES.join(","))
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    redirectPath: process.env.SHOPIFY_REDIRECT_PATH || "/auth/shopify/callback",
    accessMode: process.env.SHOPIFY_ACCESS_MODE || "offline",
    useLegacyInstallFlow: process.env.SHOPIFY_USE_LEGACY_INSTALL_FLOW === "true"
  };
}

function validateShopifyConfig(config) {
  const missing = [];

  if (!config.apiKey) missing.push("SHOPIFY_API_KEY");
  if (!config.apiSecret) missing.push("SHOPIFY_API_SECRET");
  if (!config.appUrl) missing.push("SHOPIFY_APP_URL");

  return {
    ok: missing.length === 0,
    missing
  };
}

module.exports = {
  readShopifyConfig,
  validateShopifyConfig
};
