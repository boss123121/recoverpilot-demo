const SHOPIFY_ADMIN_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || "2026-04";

const DEFAULT_WEBHOOK_SUBSCRIPTIONS = [
  {
    topic: "APP_UNINSTALLED",
    path: "/webhooks/shopify/app-uninstalled"
  },
  {
    topic: "ORDERS_CREATE",
    path: "/webhooks/shopify/orders-create",
    includeFields: [
      "id",
      "name",
      "currency",
      "total_price",
      "current_total_price",
      "checkout_token",
      "cart_token",
      "created_at",
      "processed_at"
    ]
  },
  {
    topic: "ORDERS_PAID",
    path: "/webhooks/shopify/orders-paid",
    includeFields: [
      "id",
      "name",
      "currency",
      "total_price",
      "current_total_price",
      "checkout_token",
      "cart_token",
      "created_at",
      "processed_at"
    ]
  }
];

function buildWebhookCallbackUrl(config, path) {
  return `${config.appUrl}${path}`;
}

function validateWebhookRegistrationConfig(config) {
  const missing = [];

  if (!config.appUrl) {
    missing.push("SHOPIFY_APP_URL");
  }

  if (!config.appUrl.startsWith("https://")) {
    return {
      ok: false,
      reason: "Shopify webhook registration needs a public HTTPS app URL",
      missing,
      app_url: config.appUrl
    };
  }

  return {
    ok: missing.length === 0,
    missing,
    app_url: config.appUrl
  };
}

async function graphqlAdminRequest(shop, accessToken, query, variables) {
  const response = await fetch(`https://${shop}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken
    },
    body: JSON.stringify({ query, variables })
  });

  const rawPayload = await response.text();
  let payload;

  try {
    payload = rawPayload ? JSON.parse(rawPayload) : {};
  } catch (error) {
    payload = {
      raw: rawPayload
    };
  }

  if (!response.ok) {
    const details = typeof payload.errors === "string"
      ? payload.errors
      : JSON.stringify(payload.errors || payload.raw || payload);
    throw new Error(`Shopify Admin GraphQL request failed (${response.status}): ${details}`);
  }

  if (payload.errors) {
    const details = Array.isArray(payload.errors)
      ? payload.errors.map((error) => error.message || JSON.stringify(error)).join("; ")
      : JSON.stringify(payload.errors);
    throw new Error(`Shopify Admin GraphQL returned errors: ${details}`);
  }

  return payload;
}

async function createWebhookSubscription(shop, accessToken, subscription) {
  const query = `
    mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription {
          id
          topic
          includeFields
          uri
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const webhookSubscription = {
    uri: subscription.uri
  };

  if (subscription.includeFields?.length > 0) {
    webhookSubscription.includeFields = subscription.includeFields;
  }

  const payload = await graphqlAdminRequest(shop, accessToken, query, {
    topic: subscription.topic,
    webhookSubscription
  });

  const result = payload.data?.webhookSubscriptionCreate;
  const userErrors = result?.userErrors || [];
  const alreadyExists = userErrors.some((error) => {
    return String(error.message || "").toLowerCase().includes("already been taken");
  });

  return {
    ok: userErrors.length === 0 || alreadyExists,
    topic: subscription.topic,
    uri: subscription.uri,
    include_fields: subscription.includeFields || [],
    already_exists: alreadyExists,
    subscription: result?.webhookSubscription || null,
    user_errors: alreadyExists ? [] : userErrors
  };
}

async function listWebhookSubscriptions(shop, accessToken) {
  const query = `
    query webhookSubscriptions {
      webhookSubscriptions(first: 20) {
        nodes {
          id
          topic
          uri
          includeFields
        }
      }
    }
  `;

  const payload = await graphqlAdminRequest(shop, accessToken, query, {});

  return payload.data?.webhookSubscriptions?.nodes || [];
}

async function registerDefaultWebhookSubscriptions(config, store) {
  const readiness = validateWebhookRegistrationConfig(config);

  if (!readiness.ok) {
    return {
      ok: false,
      reason: readiness.reason,
      app_url: readiness.app_url,
      subscriptions: DEFAULT_WEBHOOK_SUBSCRIPTIONS.map((subscription) => ({
        topic: subscription.topic,
        uri: buildWebhookCallbackUrl(config, subscription.path),
        ready: false
      }))
    };
  }

  const results = [];

  for (const subscription of DEFAULT_WEBHOOK_SUBSCRIPTIONS) {
    const uri = buildWebhookCallbackUrl(config, subscription.path);
    results.push(await createWebhookSubscription(store.store_domain, store.shopify_access_token, {
      ...subscription,
      uri
    }));
  }

  return {
    ok: results.every((item) => item.ok),
    app_url: config.appUrl,
    subscriptions: results
  };
}

module.exports = {
  DEFAULT_WEBHOOK_SUBSCRIPTIONS,
  buildWebhookCallbackUrl,
  listWebhookSubscriptions,
  registerDefaultWebhookSubscriptions,
  validateWebhookRegistrationConfig
};
