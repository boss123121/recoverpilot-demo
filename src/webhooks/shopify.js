const crypto = require("crypto");

const { addActivity, processPurchaseEvent } = require("../retargeting");
const { isValidShopDomain } = require("../shopify/auth");

function getHeaderValue(headers, name) {
  if (!headers) {
    return null;
  }

  const value = headers[name] ?? headers[name.toLowerCase()];
  return value == null ? null : String(value);
}

function verifyShopifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (!rawBody || !hmacHeader || !secret) {
    return false;
  }

  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const expected = Buffer.from(digest, "utf8");
  const provided = Buffer.from(String(hmacHeader), "utf8");

  if (expected.length !== provided.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, provided);
}

function validateShopifyWebhookRequest(request, rawBody, secret) {
  const topic = getHeaderValue(request.headers, "x-shopify-topic");
  const shop = getHeaderValue(request.headers, "x-shopify-shop-domain");
  const hmac = getHeaderValue(request.headers, "x-shopify-hmac-sha256");
  const webhookId = getHeaderValue(request.headers, "x-shopify-webhook-id");
  const apiVersion = getHeaderValue(request.headers, "x-shopify-api-version");

  if (!topic) {
    return {
      ok: false,
      statusCode: 400,
      error: "Missing Shopify webhook topic"
    };
  }

  if (!shop || !isValidShopDomain(shop)) {
    return {
      ok: false,
      statusCode: 400,
      error: "Missing or invalid Shopify shop domain"
    };
  }

  if (!hmac) {
    return {
      ok: false,
      statusCode: 401,
      error: "Missing Shopify webhook HMAC"
    };
  }

  if (!verifyShopifyWebhookHmac(rawBody, hmac, secret)) {
    return {
      ok: false,
      statusCode: 401,
      error: "Invalid Shopify webhook HMAC"
    };
  }

  return {
    ok: true,
    topic,
    shop,
    hmac,
    webhookId,
    apiVersion
  };
}

function buildStoreIdFromShopDomain(shop) {
  return `shop_${shop.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;
}

function resolveStoreId(state, shop) {
  const existingStore = state.stores.find((item) => item.store_domain === shop);
  return existingStore?.store_id || buildStoreIdFromShopDomain(shop);
}

function parseJsonSafely(rawBody) {
  try {
    return {
      ok: true,
      payload: JSON.parse(rawBody)
    };
  } catch (error) {
    return {
      ok: false,
      error: "Invalid JSON body"
    };
  }
}

function buildWebhookReceiptEventId(webhookId) {
  return `shopify_webhook_${webhookId}`;
}

function recordWebhookReceipt(state, context, now = new Date()) {
  if (!context.webhookId) {
    return null;
  }

  const eventId = buildWebhookReceiptEventId(context.webhookId);
  state.events.push({
    event_id: eventId,
    event_type: "shopify_webhook",
    topic: context.topic,
    shop_domain: context.shop,
    api_version: context.apiVersion || null,
    received_at: now.toISOString()
  });

  return eventId;
}

function extractCheckoutTokenFromUrl(checkoutUrl) {
  if (!checkoutUrl) {
    return null;
  }

  const match = String(checkoutUrl).match(/\/checkouts\/([^/?]+)/i);
  return match ? match[1] : null;
}

function findMatchingCartForOrder(state, storeId, payload) {
  const checkoutToken = payload?.checkout_token || null;
  const cartToken = payload?.cart_token || null;
  const customerId = payload?.customer?.id ? String(payload.customer.id) : null;
  const storeCarts = state.carts.filter((cart) => cart.store_id === storeId);

  if (checkoutToken) {
    const checkoutMatch = storeCarts.find((cart) => {
      const knownTokens = [
        cart.cart_id,
        cart.checkout_token,
        cart.shopify_checkout_token,
        extractCheckoutTokenFromUrl(cart.checkout_url)
      ].filter(Boolean);

      return knownTokens.includes(checkoutToken) || knownTokens.includes(`shopify_checkout_${checkoutToken}`);
    });

    if (checkoutMatch) {
      return checkoutMatch;
    }
  }

  if (cartToken) {
    const cartTokenMatch = storeCarts.find((cart) => {
      const knownCartTokens = [cart.cart_token, cart.shopify_cart_token].filter(Boolean);
      return knownCartTokens.includes(cartToken);
    });

    if (cartTokenMatch) {
      return cartTokenMatch;
    }
  }

  if (customerId) {
    const customerMatches = storeCarts
      .filter((cart) => {
        return [customerId, `shopify_customer_${customerId}`].includes(cart.customer_id) &&
          cart.status === "abandoned";
      })
      .sort((a, b) => new Date(b.abandoned_at || 0) - new Date(a.abandoned_at || 0));

    return customerMatches[0] || null;
  }

  return null;
}

function processShopifyAppUninstalled(state, context, payload, now = new Date()) {
  const storeId = resolveStoreId(state, context.shop);
  const existingStore = state.stores.find((item) => item.store_id === storeId || item.store_domain === context.shop);
  const nextStoreId = existingStore?.store_id || storeId;
  const timestamp = now.toISOString();

  if (!existingStore) {
    state.stores.push({
      store_id: nextStoreId,
      store_name: payload?.name || context.shop.replace(".myshopify.com", ""),
      store_domain: context.shop,
      app_status: "uninstalled",
      updated_at: timestamp
    });
  } else {
    existingStore.app_status = "uninstalled";
    existingStore.shopify_access_token = null;
    existingStore.shopify_refresh_token = null;
    existingStore.shopify_token_expires_at = null;
    existingStore.updated_at = timestamp;
  }

  addActivity(
    state,
    "shopify_app_uninstalled",
    `Shopify app uninstalled for ${context.shop}`,
    {
      store_id: nextStoreId,
      store_domain: context.shop,
      topic: context.topic,
      webhook_id: context.webhookId || null
    },
    now
  );

  return {
    ok: true,
    action: "app_uninstalled",
    store_id: nextStoreId,
    store_domain: context.shop
  };
}

function processShopifyOrdersCreate(state, context, payload, now = new Date()) {
  const storeId = resolveStoreId(state, context.shop);
  const checkoutToken = payload?.checkout_token || payload?.cart_token || null;
  const orderId = payload?.admin_graphql_api_id || String(payload?.id || "");
  const orderNumber = payload?.name || payload?.order_number || null;
  const currency = payload?.currency || payload?.presentment_currency || null;
  const totalPrice = Number(payload?.current_total_price ?? payload?.total_price ?? 0);
  const customerId = payload?.customer?.id ? String(payload.customer.id) : null;
  const matchingCart = findMatchingCartForOrder(state, storeId, payload);

  addActivity(
    state,
    "shopify_order_webhook_received",
    `Shopify order webhook received for ${context.shop}`,
    {
      store_id: storeId,
      store_domain: context.shop,
      topic: context.topic,
      webhook_id: context.webhookId || null,
      shopify_order_id: orderId || null,
      order_name: orderNumber,
      checkout_token: checkoutToken
    },
    now
  );

  if (!matchingCart) {
    addActivity(
      state,
      "shopify_order_not_mapped",
      `Shopify order could not be mapped to a known cart for ${context.shop}`,
      {
        store_id: storeId,
        store_domain: context.shop,
        topic: context.topic,
        webhook_id: context.webhookId || null,
        shopify_order_id: orderId || null,
        checkout_token: checkoutToken
      },
      now
    );

    return {
      ok: true,
      action: "order_received",
      store_id: storeId,
      store_domain: context.shop,
      order_id: orderId || null,
      checkout_token: checkoutToken,
      customer_id: customerId,
      currency,
      order_total: Number.isFinite(totalPrice) ? totalPrice : 0,
      mapped_to_cart: false
    };
  }

  const purchaseEvent = {
    event_type: "purchase",
    event_id: `evt_shopify_purchase_${context.webhookId || orderId || now.getTime()}`,
    store_id: storeId,
    cart_id: matchingCart.cart_id,
    order_id: orderId || `order_${now.getTime()}`,
    order_value: Number.isFinite(totalPrice) ? totalPrice : 0,
    currency: currency || matchingCart.currency || "USD",
    purchased_at: payload?.processed_at || payload?.created_at || now.toISOString()
  };

  const purchaseResult = processPurchaseEvent(state, purchaseEvent, now);

  addActivity(
    state,
    "shopify_order_mapped_to_cart",
    `Shopify order mapped to cart ${matchingCart.cart_id}`,
    {
      store_id: storeId,
      store_domain: context.shop,
      topic: context.topic,
      webhook_id: context.webhookId || null,
      shopify_order_id: orderId || null,
      cart_id: matchingCart.cart_id,
      conversion_created: purchaseResult.statusCode === 201
    },
    now
  );

  return {
    ok: true,
    action: "order_received",
    store_id: storeId,
    store_domain: context.shop,
    order_id: orderId || null,
    checkout_token: checkoutToken,
    customer_id: customerId,
    currency,
    order_total: Number.isFinite(totalPrice) ? totalPrice : 0,
    mapped_to_cart: true,
    cart_id: matchingCart.cart_id,
    purchase_result: purchaseResult.body
  };
}

module.exports = {
  buildStoreIdFromShopDomain,
  buildWebhookReceiptEventId,
  findMatchingCartForOrder,
  parseJsonSafely,
  processShopifyAppUninstalled,
  processShopifyOrdersCreate,
  recordWebhookReceipt,
  resolveStoreId,
  validateShopifyWebhookRequest,
  verifyShopifyWebhookHmac
};
