const http = require("http");

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const base = new URL(BASE_URL);

function request(method, path, payload) {
  const body = payload ? JSON.stringify(payload) : "";

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port || 80,
        path,
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function post(path, payload) {
  const response = await request("POST", path, payload);
  assert(response.statusCode >= 200 && response.statusCode < 300, `${path} returned ${response.statusCode}`);
  assert(response.body?.ok !== false, `${path} failed: ${response.body?.error || "unknown error"}`);
  return response.body;
}

async function get(path) {
  const response = await request("GET", path);
  assert(response.statusCode >= 200 && response.statusCode < 300, `${path} returned ${response.statusCode}`);
  assert(response.body?.ok !== false, `${path} failed: ${response.body?.error || "unknown error"}`);
  return response.body;
}

async function waitForMessageStatus(status, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const dashboard = await get("/api/dashboard");
    const message = dashboard.messages.find((item) => item.status === status);

    if (message) {
      return { dashboard, message };
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for message status: ${status}`);
}

async function main() {
  console.log(`Phase 12 internal check against ${BASE_URL}`);

  await get("/health");
  console.log("1. Server health OK");

  await post("/demo/reset");
  await post("/campaign/settings", {
    store_id: "store_demo_fashion_001",
    enabled: true,
    delay_minutes: 0,
    attribution_window_days: 7,
    message_template: "Hi {{first_name}}, you left items in your cart. Complete your order here: {{checkout_url}}"
  });
  console.log("2. Demo state reset and campaign enabled");

  const abandoned = await post("/demo/abandoned-cart");
  assert(abandoned.message?.status === "scheduled", "Expected abandoned cart to schedule a message");
  console.log("3. Abandoned cart created and message scheduled");

  await post("/automation/run");
  let sent;

  try {
    sent = await waitForMessageStatus("fake_sent", 3);
    assert(sent.message.send_attempts === 1, "Expected fake WhatsApp send attempt");
    console.log("4. Automation sent the fake WhatsApp message");
  } catch (error) {
    const dashboard = await get("/api/dashboard");
    const manualItem = dashboard.recovery_queue.find((item) => item.can_mark_sent);
    assert(manualItem, "Expected a manual recovery queue item");
    await post("/manual-pilot/messages/mark-sent", {
      message_id: manualItem.message_id
    });
    sent = await waitForMessageStatus("manual_sent");
    assert(sent.message.send_attempts === 1, "Expected manual send confirmation");
    console.log("4. Manual pilot marked the WhatsApp message as sent");
  }

  const purchase = await post("/demo/purchase");
  assert(purchase.conversion?.recovered_by_message === true, "Expected purchase to be credited to sent message");
  assert(Number(purchase.conversion?.recovered_revenue) > 0, "Expected recovered revenue above zero");
  console.log("5. Purchase credited as recovered revenue");

  const dashboard = await get("/api/dashboard");
  assert(dashboard.metrics.abandoned_carts === 1, "Expected one abandoned cart");
  assert(dashboard.metrics.messages === 1, "Expected one message");
  assert(dashboard.metrics.conversions === 1, "Expected one conversion");
  assert(Number(dashboard.metrics.recovered_revenue) > 0, "Expected recovered revenue on dashboard");
  assert(dashboard.audits.some((item) => item.decision === "Revenue attribution"), "Expected revenue audit row");
  console.log("6. Dashboard and audit confirm the full flow");

  console.log("Phase 12 internal end-to-end check passed.");
}

main().catch((error) => {
  console.error(`Phase 12 internal check failed: ${error.message}`);
  process.exitCode = 1;
});
