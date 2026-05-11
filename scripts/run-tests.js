const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const PORT = 3100;
const rootDir = path.join(__dirname, "..");
const testDataDir = path.join(rootDir, "data", ".test");

process.env.RecoverPilot_DATA_DIR = testDataDir;

const { DB_FILE, emptyState, readState: loadState, writeState: saveState } = require("../src/state");

const dbPath = DB_FILE;
let latestServerStdout = "";
let latestServerStderr = "";

function request(method, route, payload) {
  const body = payload ? JSON.stringify(payload) : "";

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port: PORT,
        path: route,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (res) => {
        let responseBody = "";

        res.on("data", (chunk) => {
          responseBody += chunk;
        });

        res.on("end", () => {
          try {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: responseBody ? JSON.parse(responseBody) : null
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function requestRaw(method, route, body = "", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port: PORT,
        path: route,
        method,
        headers: {
          "Content-Length": Buffer.byteLength(body),
          ...headers
        }
      },
      (res) => {
        let responseBody = "";

        res.on("data", (chunk) => {
          responseBody += chunk;
        });

        res.on("end", () => {
          try {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: responseBody ? JSON.parse(responseBody) : null
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function shopifyWebhookHeaders(topic, shop, body, secret, overrides = {}) {
  const hmac = crypto.createHmac("sha256", secret).update(body).digest("base64");
  return {
    "Content-Type": "application/json",
    "X-Shopify-Topic": topic,
    "X-Shopify-Shop-Domain": shop,
    "X-Shopify-Hmac-SHA256": hmac,
    "X-Shopify-Webhook-Id": overrides.webhookId || `wh_${topic.replace(/[^a-z0-9]/gi, "_")}`,
    "X-Shopify-API-Version": "2026-04",
    ...overrides.headers
  };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await request("GET", "/health");
      if (response.statusCode === 200) return;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error("Server did not start");
}

function abandonedEvent(overrides = {}) {
  const id = overrides.id || "001";
  return {
    event_type: "abandoned_cart",
    event_id: `evt_test_${id}`,
    store: {
      store_id: "store_test_fashion",
      store_name: "Test Fashion Store",
      store_domain: "test-fashion.myshopify.com"
    },
    customer: {
      customer_id: `cus_test_${id}`,
      first_name: "Test",
      phone: "+10000000000",
      email: `test_${id}@example.com`,
      whatsapp_consent: overrides.whatsapp_consent ?? true
    },
    cart: {
      cart_id: `cart_test_${id}`,
      checkout_url: `https://example.com/checkouts/cart_test_${id}`,
      currency: "USD",
      cart_value: overrides.cart_value ?? 100,
      items: [
        {
          product_id: `prod_test_${id}`,
          product_name: "Test Jacket",
          quantity: 1,
          price: overrides.cart_value ?? 100
        }
      ],
      abandoned_at: "2026-04-27T10:00:00Z",
      status: "abandoned"
    },
    campaign: {
      channel: "whatsapp",
      delay_minutes: overrides.delay_minutes ?? 60,
      max_messages_per_cart: 1
    }
  };
}

function purchaseEvent(id = "001") {
  return {
    event_type: "purchase",
    event_id: `evt_purchase_test_${id}`,
    store_id: "store_test_fashion",
    cart_id: `cart_test_${id}`,
    order_id: `order_test_${id}`,
    order_value: 100,
    currency: "USD",
    purchased_at: "2026-04-27T11:05:00Z"
  };
}

async function main() {
  const originalDbState = fs.existsSync(dbPath) ? await loadState() : null;
  await saveState(emptyState());

  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      AUTO_WORKER: "false",
      SHOPIFY_API_KEY: "test_shopify_key",
      SHOPIFY_API_SECRET: "test_shopify_secret",
      SHOPIFY_APP_URL: `http://localhost:${PORT}`,
      SHOPIFY_SCOPES: "read_orders,read_customers",
      MANUAL_PILOT_MODE: "false",
      RecoverPilot_DATA_DIR: testDataDir,
      TWILIO_WHATSAPP_ENABLED: "false",
      TWILIO_ACCOUNT_SID: "",
      TWILIO_AUTH_TOKEN: "",
      TWILIO_WHATSAPP_FROM: "",
      TWILIO_TEST_WHATSAPP_TO: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverStdout = "";
  let serverStderr = "";
  server.stdout.on("data", (chunk) => {
    serverStdout += chunk.toString();
    latestServerStdout = serverStdout;
  });
  server.stderr.on("data", (chunk) => {
    serverStderr += chunk.toString();
    latestServerStderr = serverStderr;
  });

  try {
    await waitForServer();

    let response = await request("GET", "/auth/shopify/status");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.shopify.configured, true);
    assert.ok(response.body.shopify.scopes.includes("read_orders"));

    response = await request("GET", "/automation/status");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.auto_worker.enabled, false);
    assert.strictEqual(response.body.auto_worker.running, false);
    assert.strictEqual(response.body.queue.due_scheduled_messages, 0);

    response = await request("GET", "/sender/twilio-whatsapp/status");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.enabled, false);
    assert.strictEqual(response.body.configured, false);
    assert.ok(response.body.missing.includes("TWILIO_ACCOUNT_SID"));

    response = await request("POST", "/sender/twilio-whatsapp/test", {
      to: "whatsapp:+10000000000",
      body: "Test"
    });
    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(response.body.error, "Twilio WhatsApp sending is disabled");

    response = await request("POST", "/sender/twilio-whatsapp/run");
    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(response.body.error, "Twilio WhatsApp sending is disabled");

    response = await request("POST", "/sender/twilio-whatsapp/sync-status");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.checked, 0);

    response = await request("GET", "/auth/shopify/start?shop=not-a-valid-shop");
    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(response.body.error, "Invalid Shopify shop domain");

    response = await request("GET", "/auth/shopify/start?shop=test-fashion.myshopify.com");
    assert.strictEqual(response.statusCode, 302);
    assert.ok(response.headers.location.includes("https://test-fashion.myshopify.com/admin/oauth/authorize"));

    response = await request("POST", "/auth/shopify/register-webhooks?shop=test-fashion.myshopify.com");
    assert.strictEqual(response.statusCode, 404);
    assert.strictEqual(response.body.error, "Installed Shopify store with access token not found");

    response = await request("POST", "/shopify/abandoned-checkouts/import?shop=test-fashion.myshopify.com&limit=5");
    assert.strictEqual(response.statusCode, 404);
    assert.strictEqual(response.body.error, "Installed Shopify store with access token not found");

    response = await request("POST", "/shopify/orders/import?shop=test-fashion.myshopify.com&limit=5");
    assert.strictEqual(response.statusCode, 404);
    assert.strictEqual(response.body.error, "Installed Shopify store with access token not found");

    response = await request("GET", "/shopify/ingestion/status?shop=test-fashion.myshopify.com");
    assert.strictEqual(response.statusCode, 404);
    assert.strictEqual(response.body.error, "Shopify store not found in local database");

    const uninstallBody = JSON.stringify({
      id: 1,
      name: "Test Fashion Store"
    });

    response = await requestRaw(
      "POST",
      "/webhooks/shopify/app-uninstalled",
      uninstallBody,
      shopifyWebhookHeaders(
        "app/uninstalled",
        "test-fashion.myshopify.com",
        uninstallBody,
        "test_shopify_secret"
      )
    );
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.result.action, "app_uninstalled");

    let state = await loadState();
    let webhookStore = state.stores.find((item) => item.store_domain === "test-fashion.myshopify.com");
    assert.ok(webhookStore);
    assert.strictEqual(webhookStore.app_status, "uninstalled");
    assert.ok(state.activity.some((item) => item.type === "shopify_app_uninstalled"));
    assert.ok(state.events.some((item) => item.event_type === "shopify_webhook"));

    response = await request("GET", "/shopify/ingestion/status?shop=test-fashion.myshopify.com");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.phase, "16");
    assert.strictEqual(response.body.store.app_status, "uninstalled");
    assert.strictEqual(response.body.store.has_access_token, false);
    assert.strictEqual(response.body.readiness.phase_10_ready, false);
    assert.strictEqual(response.body.readiness.phase_16_ready_to_test, false);

    response = await request("GET", "/api/dashboard");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.active_store.store_domain, "test-fashion.myshopify.com");
    assert.strictEqual(response.body.active_store.has_shopify_access_token, false);

    state = await loadState();
    webhookStore = state.stores.find((item) => item.store_domain === "test-fashion.myshopify.com");
    webhookStore.app_status = "installed";
    webhookStore.shopify_access_token = "shpat_test_secret_dashboard_token";
    webhookStore.shopify_scope = "read_orders,read_customers";
    await saveState(state);

    response = await request("GET", "/api/dashboard");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.active_store.has_shopify_access_token, true);
    assert.ok(response.body.active_store.shopify_scopes.includes("read_orders"));
    assert.ok(!JSON.stringify(response.body).includes("shpat_test_secret_dashboard_token"));

    response = await request("GET", "/pilot/readiness");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.phase, "17");
    assert.strictEqual(response.body.active_store.has_shopify_access_token, true);
    assert.ok(response.body.checks.some((item) => item.id === "shopify_store" && item.status === "ready"));
    assert.ok(response.body.checks.some((item) => item.id === "public_app_url" && item.status === "action_needed"));
    assert.ok(!JSON.stringify(response.body).includes("shpat_test_secret_dashboard_token"));

    response = await request("GET", "/pilot/package");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.phase, "19-first-pilot-package");
    assert.strictEqual(response.body.offer.name, "14-day WhatsApp abandoned-cart recovery pilot");
    assert.ok(response.body.qualification_questions.includes("Are you using Shopify?"));
    assert.ok(!JSON.stringify(response.body).includes("shpat_test_secret_dashboard_token"));

    response = await request("GET", "/client-pilot/plan");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.phase, "20-first-client-pilot");
    assert.strictEqual(response.body.recommended_mode, "manual_review");
    assert.ok(response.body.readiness.checks.some((item) => item.id === "one_store_only"));
    assert.ok(response.body.onboarding_sequence.includes("Operate the Recovery Queue daily."));
    assert.ok(response.body.daily_routine.includes("Record replies and objection tags."));
    assert.ok(!JSON.stringify(response.body).includes("shpat_test_secret_dashboard_token"));

    response = await request("GET", "/production/readiness");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.phase, "18-production-self-trial");
    assert.strictEqual(response.body.active_store.has_shopify_access_token, true);
    assert.ok(response.body.self_trial.checks.some((item) => item.id === "shopify_install" && item.status === "ready"));
    assert.ok(response.body.self_trial.checks.some((item) => item.id === "public_callback" && item.status === "blocked"));
    assert.strictEqual(response.body.public_launch.status, "blocked");
    assert.ok(!JSON.stringify(response.body).includes("shpat_test_secret_dashboard_token"));

    response = await requestRaw(
      "POST",
      "/webhooks/shopify/orders-create",
      JSON.stringify({ id: 123 }),
      {
        "Content-Type": "application/json",
        "X-Shopify-Topic": "orders/create",
        "X-Shopify-Shop-Domain": "test-fashion.myshopify.com",
        "X-Shopify-Hmac-SHA256": "bad_hmac"
      }
    );
    assert.strictEqual(response.statusCode, 401);
    assert.strictEqual(response.body.error, "Invalid Shopify webhook HMAC");

    const orderBody = JSON.stringify({
      id: 987654321,
      name: "#1001",
      currency: "USD",
      total_price: "128.50",
      checkout_token: "checkout_token_001",
      customer: {
        id: 555
      }
    });

    response = await requestRaw(
      "POST",
      "/webhooks/shopify/orders-create",
      orderBody,
      shopifyWebhookHeaders(
        "orders/create",
        "test-fashion.myshopify.com",
        orderBody,
        "test_shopify_secret"
      )
    );
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.result.action, "order_received");
    assert.strictEqual(response.body.result.order_total, 128.5);

    state = await loadState();
    assert.ok(state.activity.some((item) => item.type === "shopify_order_webhook_received"));
    assert.ok(state.activity.some((item) => item.type === "shopify_order_not_mapped"));

    response = await requestRaw(
      "POST",
      "/webhooks/shopify/orders-create",
      orderBody,
      shopifyWebhookHeaders(
        "orders/create",
        "test-fashion.myshopify.com",
        orderBody,
        "test_shopify_secret"
      )
    );
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.duplicate, true);

    await saveState(emptyState());

    response = await request("POST", "/events/abandoned-cart", abandonedEvent({ id: "001" }));
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(response.body.message.status, "scheduled");

    response = await request("POST", "/events/abandoned-cart", abandonedEvent({ id: "001" }));
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.duplicate, true);

    state = await loadState();
    assert.strictEqual(state.events.length, 1);
    assert.strictEqual(state.messages.length, 1);
    assert.ok(state.activity.some((item) => item.type === "duplicate_event_ignored"));

    const sameCartNewEvent = abandonedEvent({ id: "001" });
    sameCartNewEvent.event_id = "evt_test_001_second_webhook";

    response = await request("POST", "/events/abandoned-cart", sameCartNewEvent);
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(response.body.message.status, "not_scheduled");
    assert.strictEqual(response.body.message.reason, "A message already exists for this cart");

    state = await loadState();
    assert.strictEqual(state.events.length, 2);
    assert.strictEqual(state.messages.length, 1);
    assert.ok(state.activity.some((item) => item.type === "message_limit_reached"));

    response = await request("POST", "/campaign/settings", {
      store_id: "store_test_fashion",
      enabled: true,
      delay_minutes: 15,
      message_template: "Hey {{first_name}}, your cart is here: {{checkout_url}}"
    });
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.settings.unsent_messages_updated, 1);

    state = await loadState();
    assert.ok(state.messages[0].message_preview.startsWith("Hey Test"));

    response = await request("POST", "/events/abandoned-cart", abandonedEvent({ id: "002", whatsapp_consent: false }));
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(response.body.message.status, "not_scheduled");
    assert.strictEqual(response.body.message.reason, "Customer does not have WhatsApp consent");

    state = await loadState();
    assert.strictEqual(state.messages.length, 1);
    assert.ok(state.activity.some((item) => item.type === "message_not_scheduled"));

    response = await request("POST", "/self-trial/carts/mark-whatsapp-consent", {
      cart_id: "cart_test_002"
    });
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.customer.whatsapp_consent, true);
    assert.strictEqual(response.body.message.status, "ready_to_send");
    assert.strictEqual(response.body.message.consent_override, true);

    state = await loadState();
    assert.ok(state.messages.some((item) => item.cart_id === "cart_test_002"));
    assert.ok(state.activity.some((item) => item.type === "self_trial_whatsapp_consent_confirmed"));

    response = await request("POST", "/campaign/settings", {
      store_id: "store_test_fashion",
      enabled: false,
      delay_minutes: 15,
      message_template: "Test {{first_name}} {{checkout_url}}"
    });
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.settings.enabled, false);

    response = await request("POST", "/events/abandoned-cart", abandonedEvent({ id: "004" }));
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(response.body.message.status, "not_scheduled");
    assert.strictEqual(response.body.message.reason, "Campaign is turned off");

    state = await loadState();
    assert.strictEqual(state.messages.length, 2);

    response = await request("POST", "/demo/reset");
    assert.strictEqual(response.statusCode, 200);

    response = await request("POST", "/demo/campaign-off");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.settings.enabled, false);

    response = await request("POST", "/demo/abandoned-cart");
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(response.body.message.status, "not_scheduled");
    assert.strictEqual(response.body.message.reason, "Campaign is turned off");

    state = await loadState();
    assert.strictEqual(state.carts.length, 1);
    assert.strictEqual(state.messages.length, 0);
    assert.ok(state.activity.some((item) => item.type === "message_not_scheduled"));

    response = await request("POST", "/demo/reset");
    assert.strictEqual(response.statusCode, 200);

    response = await request("POST", "/demo/abandoned-cart");
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(response.body.message.status, "scheduled");

    response = await request("POST", "/demo/customer-opt-out");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.customer.whatsapp_opted_out, true);
    assert.strictEqual(response.body.cancelled_messages, 1);

    state = await loadState();
    assert.strictEqual(state.messages[0].status, "cancelled");

    response = await request("POST", "/demo/new-cart-same-customer");
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(response.body.message.status, "not_scheduled");
    assert.strictEqual(response.body.message.reason, "Customer has opted out of WhatsApp");

    state = await loadState();
    assert.strictEqual(state.carts.length, 2);
    assert.strictEqual(state.messages.length, 1);
    assert.ok(state.activity.some((item) => item.type === "customer_opted_out"));

    response = await request("POST", "/demo/reset");
    assert.strictEqual(response.statusCode, 200);

    response = await request("POST", "/demo/abandoned-cart");
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(response.body.message.status, "scheduled");

    response = await request("POST", "/demo/fail-send");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.results[0].status, "failed");

    state = await loadState();
    assert.strictEqual(state.messages.length, 1);
    assert.strictEqual(state.messages[0].status, "failed");
    assert.strictEqual(state.messages[0].failure_reason, "Fake WhatsApp provider rejected the message");
    assert.strictEqual(state.messages[0].send_attempts, 1);
    assert.ok(state.activity.some((item) => item.type === "message_failed"));

    response = await request("POST", "/demo/retry-send");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.results[0].status, "fake_sent");
    assert.strictEqual(response.body.results[0].send_attempts, 2);

    state = await loadState();
    assert.strictEqual(state.messages[0].status, "fake_sent");
    assert.strictEqual(state.messages[0].send_attempts, 2);
    assert.strictEqual(state.messages[0].failure_reason, null);
    assert.ok(state.activity.some((item) => item.type === "message_retry_started"));

    state.messages[0].status = "failed";
    state.messages[0].send_attempts = 2;
    state.messages[0].failure_reason = "Still failing";
    await saveState(state);

    response = await request("POST", "/demo/retry-send");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.results[0].status, "retry_blocked");
    assert.strictEqual(response.body.results[0].reason, "Max send attempts reached");

    response = await request("POST", "/demo/reset");
    assert.strictEqual(response.statusCode, 200);

    response = await request("POST", "/demo/abandoned-cart");
    assert.strictEqual(response.statusCode, 201);

    response = await request("POST", "/demo/purchase");
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(response.body.conversion.recovered_revenue, 0);
    assert.strictEqual(response.body.conversion.recovered_by_message, false);
    assert.strictEqual(response.body.conversion.attribution_reason, "No sent recovery message");

    response = await request("POST", "/demo/reset");
    assert.strictEqual(response.statusCode, 200);

    response = await request("POST", "/demo/abandoned-cart");
    assert.strictEqual(response.statusCode, 201);

    response = await request("POST", "/demo/message-due");
    assert.strictEqual(response.statusCode, 200);

    response = await request("POST", "/scheduler/run");
    assert.strictEqual(response.statusCode, 200);

    response = await request("POST", "/sender/fake-whatsapp/run");
    assert.strictEqual(response.statusCode, 200);

    response = await request("POST", "/demo/late-purchase");
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(response.body.conversion.recovered_revenue, 0);
    assert.strictEqual(response.body.conversion.recovered_by_message, false);
    assert.strictEqual(response.body.conversion.attribution_reason, "Purchase happened outside attribution window");

    await saveState(emptyState());

    response = await request("POST", "/campaign/settings", {
      store_id: "store_test_fashion",
      enabled: true,
      delay_minutes: 15,
      message_template: "Test {{first_name}} {{checkout_url}}"
    });
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.settings.enabled, true);

    response = await request("POST", "/events/abandoned-cart", abandonedEvent({ id: "001" }));
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(response.body.message.status, "scheduled");

    state = await loadState();
    const firstMessage = state.messages.find((item) => item.cart_id === "cart_test_001");
    assert.ok(firstMessage, "Expected cart_test_001 to have one scheduled message");
    firstMessage.scheduled_at = new Date(Date.now() - 60_000).toISOString();
    await saveState(state);

    response = await request("POST", "/scheduler/run");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.results[0].status, "ready_to_send");

    response = await request("POST", "/sender/fake-whatsapp/run");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.results[0].status, "fake_sent");

    state = await loadState();
    state.messages.find((item) => item.cart_id === "cart_test_001").sent_at = "2026-04-27T11:00:00Z";
    await saveState(state);

    response = await request("POST", "/events/purchase", purchaseEvent("001"));
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(response.body.conversion.recovered_revenue, 100);

    response = await request("POST", "/events/purchase", purchaseEvent("001"));
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.duplicate, true);

    await saveState(emptyState());

    response = await request("POST", "/campaign/settings", {
      store_id: "store_test_fashion",
      enabled: true,
      delay_minutes: 0,
      attribution_window_days: 7,
      message_template: "Test {{first_name}} {{checkout_url}}"
    });
    assert.strictEqual(response.statusCode, 200);

    response = await request("POST", "/events/abandoned-cart", abandonedEvent({ id: "020" }));
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(response.body.message.status, "scheduled");

    response = await request("GET", "/automation/status");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.queue.due_scheduled_messages, 1);

    response = await request("POST", "/automation/run");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.skipped, false);
    assert.strictEqual(response.body.schedulerResults[0].status, "ready_to_send");
    assert.strictEqual(response.body.senderResults[0].status, "fake_sent");

    response = await request("GET", "/automation/status");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.last_run.run_count, 1);
    assert.strictEqual(response.body.last_run.results.senderResults[0].status, "fake_sent");
    assert.strictEqual(response.body.queue.due_scheduled_messages, 0);

    const phase12Purchase = purchaseEvent("020");
    phase12Purchase.event_id = "evt_purchase_test_020_phase12";
    phase12Purchase.order_id = "order_test_020_phase12";
    phase12Purchase.purchased_at = new Date(Date.now() + 60_000).toISOString();
    response = await request("POST", "/events/purchase", phase12Purchase);
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(response.body.conversion.recovered_revenue, 100);

    await saveState(emptyState());

    response = await request("POST", "/campaign/settings", {
      store_id: "store_test_fashion",
      enabled: true,
      delay_minutes: 0,
      attribution_window_days: 7,
      message_template: "Manual {{first_name}} {{checkout_url}}"
    });
    assert.strictEqual(response.statusCode, 200);

    response = await request("POST", "/events/abandoned-cart", abandonedEvent({ id: "030" }));
    assert.strictEqual(response.statusCode, 201);

    state = await loadState();
    const manualMessage = state.messages.find((item) => item.cart_id === "cart_test_030");
    manualMessage.status = "manual_send_needed";
    manualMessage.ready_at = new Date().toISOString();
    await saveState(state);

    response = await request("GET", "/api/dashboard");
    assert.strictEqual(response.statusCode, 200);
    assert.ok(response.body.recovery_queue.some((item) => item.message_id === manualMessage.message_id));

    response = await request("POST", "/manual-pilot/messages/mark-sent", {
      message_id: manualMessage.message_id
    });
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.message.status, "manual_sent");

    state = await loadState();
    assert.ok(state.activity.some((item) => item.type === "manual_whatsapp_marked_sent"));

    const manualPurchase = purchaseEvent("030");
    manualPurchase.event_id = "evt_purchase_test_030_manual";
    manualPurchase.order_id = "order_test_030_manual";
    manualPurchase.purchased_at = new Date(Date.now() + 60_000).toISOString();
    response = await request("POST", "/events/purchase", manualPurchase);
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(response.body.conversion.recovered_revenue, 100);
    assert.strictEqual(response.body.conversion.recovered_by_message, true);

    await saveState(emptyState());

    response = await request("POST", "/events/abandoned-cart", abandonedEvent({ id: "010" }));
    assert.strictEqual(response.statusCode, 201);

    state = await loadState();
    state.messages.find((item) => item.cart_id === "cart_test_010").status = "fake_sent";
    state.messages.find((item) => item.cart_id === "cart_test_010").sent_at = "2026-04-27T11:00:00Z";
    await saveState(state);

    const mappedOrderBody = JSON.stringify({
      id: 111222333,
      name: "#2001",
      currency: "USD",
      total_price: "100.00",
      checkout_token: "cart_test_010",
      processed_at: "2026-04-27T11:05:00Z",
      customer: {
        id: "cus_test_010"
      }
    });

    response = await requestRaw(
      "POST",
      "/webhooks/shopify/orders-create",
      mappedOrderBody,
      shopifyWebhookHeaders(
        "orders/create",
        "test-fashion.myshopify.com",
        mappedOrderBody,
        "test_shopify_secret",
        {
          webhookId: "wh_orders_create_mapped"
        }
      )
    );
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.result.mapped_to_cart, true);
    assert.strictEqual(response.body.result.cart_id, "cart_test_010");
    assert.strictEqual(response.body.result.purchase_result.conversion.recovered_revenue, 100);

    state = await loadState();
    assert.ok(state.activity.some((item) => item.type === "shopify_order_mapped_to_cart"));
    assert.ok(state.conversions.some((item) => item.cart_id === "cart_test_010"));

    response = await request("POST", "/events/abandoned-cart", abandonedEvent({ id: "003" }));
    assert.strictEqual(response.statusCode, 201);

    state = await loadState();
    const cart = state.carts.find((item) => item.cart_id === "cart_test_003");
    const message = state.messages.find((item) => item.cart_id === "cart_test_003");
    cart.status = "purchased";
    message.scheduled_at = new Date(Date.now() - 60_000).toISOString();
    await saveState(state);

    response = await request("POST", "/scheduler/run");
    const cancelled = response.body.results.find((item) => item.message_id === message.message_id);
    assert.strictEqual(cancelled.status, "cancelled");

    response = await request("GET", "/api/dashboard");
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.metrics.conversions, 1);
    assert.strictEqual(response.body.metrics.recovered_revenue, 100);
    assert.ok(response.body.audits.length >= 2);
    assert.ok(response.body.audits.some((item) => item.decision === "Message decision"));
    assert.ok(response.body.audits.some((item) => item.decision === "Revenue attribution"));
    assert.ok(response.body.activity.length >= 5);
    assert.ok(response.body.activity.some((item) => item.type === "abandoned_cart_received"));
    assert.ok(response.body.activity.some((item) => item.type === "conversion_recorded"));
    assert.ok(
      response.body.activity.some((item) => {
        return ["fake_whatsapp_sent", "shopify_order_mapped_to_cart"].includes(item.type);
      })
    );

    console.log("All tests passed.");
} finally {
    server.kill();
    if (originalDbState === null) {
      await saveState(emptyState());
    } else {
      await saveState(originalDbState);
    }
  }
}

main().catch((error) => {
  console.error(error);
  if (latestServerStdout) {
    console.error("--- server stdout ---");
    console.error(latestServerStdout);
  }
  if (latestServerStderr) {
    console.error("--- server stderr ---");
    console.error(latestServerStderr);
  }
  process.exitCode = 1;
});
