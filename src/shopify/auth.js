const crypto = require("crypto");

function isValidShopDomain(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop || "");
}

function buildShopifyHmacMessage(params) {
  return Object.keys(params)
    .filter((key) => key !== "hmac" && params[key] !== undefined)
    .sort()
    .map((key) => `${key}=${Array.isArray(params[key]) ? params[key].join(",") : params[key]}`)
    .join("&");
}

function computeShopifyHmac(params, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(buildShopifyHmacMessage(params))
    .digest("hex");
}

function verifyShopifyQueryHmac(params, secret) {
  if (!params?.hmac || !secret) {
    return false;
  }

  const expected = computeShopifyHmac(params, secret);
  const provided = String(params.hmac);

  return crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided, "utf8"));
}

function createInstallNonce() {
  return crypto.randomBytes(16).toString("hex");
}

function buildInstallRedirectUri(config) {
  return `${config.appUrl}${config.redirectPath}`;
}

function buildAuthorizeUrl(config, shop, state) {
  const params = new URLSearchParams({
    client_id: config.apiKey,
    scope: config.scopes.join(","),
    redirect_uri: buildInstallRedirectUri(config),
    state
  });

  if (config.accessMode === "per-user") {
    params.set("grant_options[]", "per-user");
  }

  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

async function exchangeAuthorizationCode(config, shop, code) {
  const body = new URLSearchParams({
    client_id: config.apiKey,
    client_secret: config.apiSecret,
    code
  });

  if (config.accessMode === "offline-expiring") {
    body.set("expiring", "1");
  }

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: body.toString()
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "Shopify token exchange failed");
  }

  return payload;
}

module.exports = {
  buildAuthorizeUrl,
  buildInstallRedirectUri,
  createInstallNonce,
  exchangeAuthorizationCode,
  isValidShopDomain,
  verifyShopifyQueryHmac
};
