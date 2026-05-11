const http = require("http");
const { URL } = require("url");

const { loadEnvFile } = require("./env");
const { buildDashboardSummary } = require("./dashboard-summary");
const { readJsonRequest, readRequestBody, sendHtml, sendJson, sendRedirect } = require("./http-utils");
const {
  DASHBOARD_FILE,
  LANDING_FILE,
  SAMPLE_ABANDONED_CART_FILE,
  SAMPLE_NO_CONSENT_ABANDONED_CART_FILE,
  SAMPLE_PURCHASE_FILE,
  readJsonFile,
  readState,
  readTextFile,
  resetState,
  writeState
} = require("./state");
const {
  addActivity,
  failNextWhatsAppMessage,
  makeScheduledMessagesDue,
  processAbandonedCartEvent,
  processCustomerOptOut,
  processSelfTrialConsentOverride,
  processPurchaseEvent,
  retryNextFailedWhatsAppMessage,
  runFakeWhatsAppFailure,
  runFakeWhatsAppSender,
  runScheduler,
  updateCampaignSettings
} = require("./retargeting");
const {
  fetchTwilioWhatsAppMessageStatus,
  normalizeWhatsAppAddress,
  readTwilioWhatsAppConfig,
  sendTwilioWhatsAppMessage,
  validateTwilioWhatsAppConfig
} = require("./messaging/twilio-whatsapp");
const { sanitizeProviderFailureReason } = require("./sanitize");
const { readShopifyConfig, validateShopifyConfig } = require("./shopify/config");
const {
  buildAuthorizeUrl,
  createInstallNonce,
  exchangeAuthorizationCode,
  isValidShopDomain,
  verifyShopifyQueryHmac
} = require("./shopify/auth");
const { consumeInstallState, saveInstallState } = require("./shopify/install-state");
const {
  DEFAULT_WEBHOOK_SUBSCRIPTIONS,
  buildWebhookCallbackUrl,
  listWebhookSubscriptions,
  registerDefaultWebhookSubscriptions,
  validateWebhookRegistrationConfig
} = require("./shopify/webhook-registration");
const { abandonedCheckoutToEvent, fetchAbandonedCheckouts } = require("./shopify/abandoned-checkouts");
const { fetchOrders } = require("./shopify/orders");
const { buildPilotReadiness } = require("./pilot-readiness");
const { buildPilotPackage } = require("./pilot-package");
const { buildClientPilotPlan } = require("./client-pilot");
const { buildProductionReadiness } = require("./production-readiness");
const {
  buildWebhookReceiptEventId,
  parseJsonSafely,
  processShopifyAppUninstalled,
  processShopifyOrdersCreate,
  recordWebhookReceipt,
  validateShopifyWebhookRequest
} = require("./webhooks/shopify");
const { validateAbandonedCartEvent, validatePurchaseEvent } = require("./validators");

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const AUTO_WORKER_ENABLED = process.env.AUTO_WORKER !== "false";
const AUTO_WORKER_INTERVAL_MS = Number(process.env.AUTO_WORKER_INTERVAL_MS || 5000);
const MANUAL_PILOT_MODE = process.env.MANUAL_PILOT_MODE !== "false";
let autoWorkerRunning = false;
const automationRuntime = {
  enabled: AUTO_WORKER_ENABLED,
  interval_ms: AUTO_WORKER_INTERVAL_MS,
  running: false,
  run_count: 0,
  last_source: null,
  last_started_at: null,
  last_completed_at: null,
  last_skipped_at: null,
  last_error: null,
  last_results: {
    schedulerResults: [],
    senderResults: [],
    skipped: false
  }
};

async function receiveAbandonedCartEvent(request, response, eventSource) {
  let event;

  try {
    event = eventSource || (await readJsonRequest(request));
  } catch (error) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid JSON body"
    });
  }

  const validationErrors = validateAbandonedCartEvent(event);
  if (validationErrors.length > 0) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid abandoned-cart event",
      details: validationErrors
    });
  }

  const state = await readState();
  const result = processAbandonedCartEvent(state, event);
  await writeState(state);
  return sendJson(response, result.statusCode, result.body);
}

async function receivePurchaseEvent(request, response, eventSource) {
  let event;

  try {
    event = eventSource || (await readJsonRequest(request));
  } catch (error) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid JSON body"
    });
  }

  const validationErrors = validatePurchaseEvent(event);
  if (validationErrors.length > 0) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid purchase event",
      details: validationErrors
    });
  }

  const state = await readState();
  const result = processPurchaseEvent(state, event);
  await writeState(state);
  return sendJson(response, result.statusCode, result.body);
}

async function runAndSave(response, action) {
  const state = await readState();
  const results = action(state);
  await writeState(state);

  return sendJson(response, 200, {
    ok: true,
    results
  });
}

function buildAutomationQueueStatus(state, now = new Date()) {
  const messageStatusCounts = {};
  let dueScheduledMessages = 0;
  let nextScheduledAt = null;

  for (const message of state.messages || []) {
    messageStatusCounts[message.status] = (messageStatusCounts[message.status] || 0) + 1;

    if (message.status !== "scheduled") {
      continue;
    }

    const scheduledAt = new Date(message.scheduled_at);
    if (Number.isNaN(scheduledAt.getTime())) {
      continue;
    }

    if (scheduledAt <= now) {
      dueScheduledMessages += 1;
    }

    if (!nextScheduledAt || scheduledAt < new Date(nextScheduledAt)) {
      nextScheduledAt = message.scheduled_at;
    }
  }

  return {
    message_status_counts: messageStatusCounts,
    due_scheduled_messages: dueScheduledMessages,
    ready_to_send_messages: messageStatusCounts.ready_to_send || 0,
    manual_send_needed_messages: messageStatusCounts.manual_send_needed || 0,
    failed_messages: messageStatusCounts.failed || 0,
    next_scheduled_at: nextScheduledAt
  };
}

async function runAutomationCycle(source = "manual") {
  if (autoWorkerRunning) {
    automationRuntime.last_skipped_at = new Date().toISOString();
    return {
      schedulerResults: [],
      senderResults: [],
      skipped: true,
      reason: "Automation cycle already running"
    };
  }

  autoWorkerRunning = true;
  automationRuntime.running = true;
  automationRuntime.last_source = source;
  automationRuntime.last_started_at = new Date().toISOString();

  try {
    const state = await readState();
    const schedulerResults = runScheduler(state, new Date(), { manualPilot: MANUAL_PILOT_MODE });
    let senderResults = [];

    if (!MANUAL_PILOT_MODE) {
      const twilioConfig = readTwilioWhatsAppConfig();
      const twilioValidation = validateTwilioWhatsAppConfig(twilioConfig);
      senderResults = twilioConfig.enabled && twilioValidation.ok
        ? await runTwilioWhatsAppSenderForState(state, twilioConfig)
        : runFakeWhatsAppSender(state);
    }

    await writeState(state);

    const result = {
      schedulerResults,
      senderResults,
      skipped: false
    };

    automationRuntime.run_count += 1;
    automationRuntime.last_completed_at = new Date().toISOString();
    automationRuntime.last_error = null;
    automationRuntime.last_results = result;

    return result;
  } catch (error) {
    automationRuntime.last_error = error.message;
    throw error;
  } finally {
    autoWorkerRunning = false;
    automationRuntime.running = false;
  }
}

async function handleAutomationStatus(response) {
  const state = await readState();

  sendJson(response, 200, {
    ok: true,
    auto_worker: {
      enabled: AUTO_WORKER_ENABLED,
      interval_ms: AUTO_WORKER_INTERVAL_MS,
      running: automationRuntime.running,
      manual_pilot_mode: MANUAL_PILOT_MODE
    },
    last_run: {
      source: automationRuntime.last_source,
      run_count: automationRuntime.run_count,
      started_at: automationRuntime.last_started_at,
      completed_at: automationRuntime.last_completed_at,
      skipped_at: automationRuntime.last_skipped_at,
      error: automationRuntime.last_error,
      results: automationRuntime.last_results
    },
    queue: buildAutomationQueueStatus(state)
  });
}

function messageCanBeMarkedManualSent(message) {
  return ["manual_send_needed", "ready_to_send", "failed"].includes(message.status);
}

function markManualMessageSent(state, messageId, note = "", now = new Date()) {
  const message = state.messages.find((item) => item.message_id === messageId);

  if (!message) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: "Message not found"
      }
    };
  }

  if (!messageCanBeMarkedManualSent(message)) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: "Message is not ready for manual send",
        message_status: message.status
      }
    };
  }

  const customer = state.customers.find((item) => item.customer_id === message.customer_id);
  const cart = state.carts.find((item) => item.cart_id === message.cart_id);

  if (!customer) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: "Customer not found for message"
      }
    };
  }

  if (!cart) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: "Cart not found for message"
      }
    };
  }

  if (!customer.whatsapp_consent) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: "Cannot mark sent because customer does not have WhatsApp consent"
      }
    };
  }

  if (cart.status === "purchased") {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: "Cannot mark sent because cart is already purchased"
      }
    };
  }

  message.status = "manual_sent";
  message.send_attempts = (Number(message.send_attempts) || 0) + 1;
  message.sent_at = now.toISOString();
  message.manual_sent_at = now.toISOString();
  message.manual_operator_note = note || null;
  message.last_failure_reason = message.failure_reason || message.last_failure_reason || null;
  message.failure_reason = null;
  message.failed_at = null;
  message.updated_at = now.toISOString();
  addActivity(
    state,
    "manual_whatsapp_marked_sent",
    `Manual WhatsApp marked sent for ${customer.first_name || "customer"}`,
    {
      message_id: message.message_id,
      cart_id: message.cart_id,
      customer_id: customer.customer_id
    },
    now
  );

  return {
    statusCode: 200,
    body: {
      ok: true,
      message
    }
  };
}

function retryFailedMessage(state, messageId, maxAttempts = 2, now = new Date()) {
  const message = state.messages.find((item) => item.message_id === messageId);

  if (!message) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: "Message not found"
      }
    };
  }

  if (message.status !== "failed") {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: "Only failed messages can be retried",
        message_status: message.status
      }
    };
  }

  const sendAttempts = Number(message.send_attempts) || 0;
  if (sendAttempts >= maxAttempts) {
    addActivity(
      state,
      "message_retry_blocked",
      "Message retry blocked because max attempts were reached",
      {
        message_id: message.message_id,
        cart_id: message.cart_id,
        send_attempts: sendAttempts,
        max_attempts: maxAttempts
      },
      now
    );

    return {
      statusCode: 400,
      body: {
        ok: false,
        error: "Max send attempts reached",
        send_attempts: sendAttempts,
        max_attempts: maxAttempts
      }
    };
  }

  const customer = state.customers.find((item) => item.customer_id === message.customer_id);
  const cart = state.carts.find((item) => item.cart_id === message.cart_id);

  if (!customer) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: "Customer not found for message"
      }
    };
  }

  if (!cart) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: "Cart not found for message"
      }
    };
  }

  if (!customer.whatsapp_consent) {
    message.status = "cancelled";
    message.cancelled_at = now.toISOString();
    message.cancel_reason = "Customer does not have WhatsApp consent";
    message.updated_at = now.toISOString();
    addActivity(
      state,
      "message_cancelled",
      "Retry cancelled because WhatsApp consent is missing",
      {
        message_id: message.message_id,
        customer_id: customer.customer_id
      },
      now
    );

    return {
      statusCode: 400,
      body: {
        ok: false,
        error: message.cancel_reason
      }
    };
  }

  if (cart.status === "purchased") {
    message.status = "cancelled";
    message.cancelled_at = now.toISOString();
    message.cancel_reason = "Cart was already purchased before retry";
    message.updated_at = now.toISOString();
    addActivity(
      state,
      "message_cancelled",
      "Retry cancelled because cart was already purchased",
      {
        message_id: message.message_id,
        cart_id: cart.cart_id
      },
      now
    );

    return {
      statusCode: 400,
      body: {
        ok: false,
        error: message.cancel_reason
      }
    };
  }

  message.status = "ready_to_send";
  message.last_failure_reason = message.failure_reason || null;
  message.failure_reason = null;
  message.failed_at = null;
  message.retry_started_at = now.toISOString();
  message.updated_at = now.toISOString();
  addActivity(
    state,
    "message_retry_started",
    "Retry queued for failed WhatsApp message",
    {
      message_id: message.message_id,
      cart_id: message.cart_id,
      next_attempt: sendAttempts + 1
    },
    now
  );

  return {
    statusCode: 200,
    body: {
      ok: true,
      message,
      next_step: "Send ready messages through the configured WhatsApp provider"
    }
  };
}

async function handleManualMessageMarkSent(request, response) {
  let body;

  try {
    body = await readJsonRequest(request);
  } catch (error) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid JSON body"
    });
  }

  if (!body.message_id) {
    return sendJson(response, 400, {
      ok: false,
      error: "message_id is required"
    });
  }

  const state = await readState();
  const result = markManualMessageSent(state, body.message_id, body.note || "");
  await writeState(state);

  return sendJson(response, result.statusCode, result.body);
}

async function handleSelfTrialConsentOverride(request, response) {
  let body;

  try {
    body = await readJsonRequest(request);
  } catch (error) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid JSON body"
    });
  }

  if (!body.cart_id) {
    return sendJson(response, 400, {
      ok: false,
      error: "cart_id is required"
    });
  }

  const state = await readState();
  const result = processSelfTrialConsentOverride(state, body.cart_id);
  await writeState(state);

  return sendJson(response, result.statusCode, result.body);
}

async function handleMessageRetry(request, response) {
  let body;

  try {
    body = await readJsonRequest(request);
  } catch (error) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid JSON body"
    });
  }

  if (!body.message_id) {
    return sendJson(response, 400, {
      ok: false,
      error: "message_id is required"
    });
  }

  const state = await readState();
  const result = retryFailedMessage(state, body.message_id);
  await writeState(state);

  return sendJson(response, result.statusCode, result.body);
}

async function handleTwilioWhatsAppStatus(response) {
  const config = readTwilioWhatsAppConfig();
  const validation = validateTwilioWhatsAppConfig(config);

  sendJson(response, 200, {
    ok: true,
    provider: "twilio_whatsapp",
    enabled: config.enabled,
    configured: validation.ok,
    missing: validation.missing,
    sandbox_from: config.from || null,
    has_test_recipient: Boolean(config.testTo),
    safety: {
      sends_require_enabled_flag: true,
      env_flag: "TWILIO_WHATSAPP_ENABLED=true",
      fake_sender_still_available: true
    }
  });
}

async function handleTwilioWhatsAppTestSend(request, response) {
  let body;

  try {
    body = await readJsonRequest(request);
  } catch (error) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid JSON body"
    });
  }

  const config = readTwilioWhatsAppConfig();
  const validation = validateTwilioWhatsAppConfig(config);

  if (!config.enabled) {
    return sendJson(response, 400, {
      ok: false,
      error: "Twilio WhatsApp sending is disabled",
      next_step: "Set TWILIO_WHATSAPP_ENABLED=true in .env after your sandbox is ready"
    });
  }

  if (!validation.ok) {
    return sendJson(response, 400, {
      ok: false,
      error: "Twilio WhatsApp configuration is incomplete",
      missing: validation.missing
    });
  }

  const to = normalizeWhatsAppAddress(body.to || config.testTo);
  const messageBody = body.body || "RecoverPilot Twilio WhatsApp sandbox test message.";

  try {
    const result = await sendTwilioWhatsAppMessage(config, to, messageBody);
    return sendJson(response, 200, {
      ok: true,
      result
    });
  } catch (error) {
    return sendJson(response, 502, {
      ok: false,
      error: "Twilio WhatsApp test send failed",
      details: sanitizeProviderFailureReason(error.message)
    });
  }
}

function twilioDeliveryFailureReason(providerResult) {
  const code = providerResult.error_code ? ` ${providerResult.error_code}` : "";
  const providerMessage = providerResult.error_message || "";

  if (String(providerResult.error_code) === "63016") {
    return "Twilio/WhatsApp rejected this free-form message because it is outside the 24-hour WhatsApp conversation window. Use an approved template, or have the customer message the sandbox first.";
  }

  return providerMessage || `Twilio delivery failed with error${code}`;
}

function twilioMessageCanSync(message) {
  return Boolean(message.provider === "twilio" && message.provider_message_id);
}

function applyTwilioMessageStatus(state, message, providerResult, now = new Date()) {
  const previousProviderStatus = message.provider_status || null;

  message.provider_status = providerResult.status || null;
  message.provider_error_code = providerResult.error_code || null;
  message.provider_error_message = providerResult.error_message || null;
  message.provider_status_checked_at = now.toISOString();
  message.provider_date_sent = providerResult.date_sent || message.provider_date_sent || null;
  message.provider_date_updated = providerResult.date_updated || null;
  message.updated_at = now.toISOString();

  if (["failed", "undelivered"].includes(providerResult.status)) {
    const reason = twilioDeliveryFailureReason(providerResult);
    const wasAlreadyFailed = message.status === "failed";

    message.status = "failed";
    message.failure_reason = sanitizeProviderFailureReason(reason);
    message.failed_at ||= now.toISOString();

    if (!wasAlreadyFailed) {
      addActivity(
        state,
        "twilio_whatsapp_delivery_failed",
        "Twilio WhatsApp delivery failed",
        {
          message_id: message.message_id,
          cart_id: message.cart_id,
          provider_message_id: providerResult.sid,
          provider_status: providerResult.status,
          provider_error_code: providerResult.error_code || null,
          reason: message.failure_reason
        },
        now
      );
    }
  }

  if (["sent", "delivered", "read"].includes(providerResult.status) && message.status !== "failed") {
    message.status = "sent";
    message.failure_reason = null;
    message.failed_at = null;
    message.sent_at ||= now.toISOString();
  }

  return {
    message_id: message.message_id,
    provider_message_id: providerResult.sid,
    previous_provider_status: previousProviderStatus,
    provider_status: message.provider_status,
    message_status: message.status,
    error_code: message.provider_error_code,
    failure_reason: message.failure_reason || null
  };
}

async function handleTwilioWhatsAppSyncStatus(response) {
  const state = await readState();
  const messages = state.messages.filter(twilioMessageCanSync);

  if (messages.length === 0) {
    return sendJson(response, 200, {
      ok: true,
      checked: 0,
      results: []
    });
  }

  const config = readTwilioWhatsAppConfig();
  const validation = validateTwilioWhatsAppConfig(config);

  if (!validation.ok) {
    return sendJson(response, 400, {
      ok: false,
      error: "Twilio WhatsApp configuration is incomplete",
      missing: validation.missing
    });
  }

  const results = [];

  for (const message of messages) {
    try {
      const providerResult = await fetchTwilioWhatsAppMessageStatus(config, message.provider_message_id);
      results.push(applyTwilioMessageStatus(state, message, providerResult));
    } catch (error) {
      results.push({
        message_id: message.message_id,
        provider_message_id: message.provider_message_id,
        status: "status_lookup_failed",
        reason: sanitizeProviderFailureReason(error.message)
      });
    }
  }

  await writeState(state);

  return sendJson(response, 200, {
    ok: true,
    checked: results.length,
    results
  });
}

function failProviderMessage(state, message, reason, now = new Date()) {
  const safeReason = sanitizeProviderFailureReason(reason);

  message.status = "failed";
  message.failure_reason = safeReason;
  message.failed_at = now.toISOString();
  message.send_attempts = (Number(message.send_attempts) || 0) + 1;
  message.updated_at = now.toISOString();
  addActivity(
    state,
    "message_failed",
    "WhatsApp message failed",
    {
      message_id: message.message_id,
      cart_id: message.cart_id,
      reason: safeReason
    },
    now
  );

  return {
    message_id: message.message_id,
    status: "failed",
    reason: safeReason
  };
}

async function runTwilioWhatsAppSenderForState(state, config) {
  const results = [];

  for (const message of state.messages) {
    if (message.status !== "ready_to_send") {
      continue;
    }

    const now = new Date();
    const customer = state.customers.find((item) => item.customer_id === message.customer_id);
    const cart = state.carts.find((item) => item.cart_id === message.cart_id);

    if (!customer) {
      results.push(failProviderMessage(state, message, "Customer not found", now));
      continue;
    }

    if (!cart) {
      results.push(failProviderMessage(state, message, "Cart not found", now));
      continue;
    }

    if (!customer.whatsapp_consent) {
      message.status = "cancelled";
      message.cancelled_at = now.toISOString();
      message.cancel_reason = "Customer does not have WhatsApp consent";
      message.updated_at = now.toISOString();
      addActivity(
        state,
        "message_cancelled",
        "Twilio send cancelled because WhatsApp consent is missing",
        {
          message_id: message.message_id,
          customer_id: message.customer_id
        },
        now
      );
      results.push({
        message_id: message.message_id,
        status: "cancelled",
        reason: message.cancel_reason
      });
      continue;
    }

    if (cart.status === "purchased") {
      message.status = "cancelled";
      message.cancelled_at = now.toISOString();
      message.cancel_reason = "Cart was already purchased before sending";
      message.updated_at = now.toISOString();
      addActivity(
        state,
        "message_cancelled",
        "Twilio send cancelled because cart was already purchased",
        {
          message_id: message.message_id,
          cart_id: message.cart_id
        },
        now
      );
      results.push({
        message_id: message.message_id,
        status: "cancelled",
        reason: message.cancel_reason
      });
      continue;
    }

    try {
      const providerResult = await sendTwilioWhatsAppMessage(config, customer.phone, message.message_preview);
      message.status = "sent";
      message.send_attempts = (Number(message.send_attempts) || 0) + 1;
      message.provider = "twilio";
      message.provider_message_id = providerResult.sid;
      message.provider_status = providerResult.status;
      message.failure_reason = null;
      message.failed_at = null;
      message.sent_at = now.toISOString();
      message.updated_at = now.toISOString();
      addActivity(
        state,
        "twilio_whatsapp_sent",
        `Twilio WhatsApp sent to ${customer.first_name || "customer"}`,
        {
          message_id: message.message_id,
          cart_id: message.cart_id,
          provider_message_id: providerResult.sid,
          provider_status: providerResult.status
        },
        now
      );
      results.push({
        message_id: message.message_id,
        status: "sent",
        provider: "twilio",
        provider_message_id: providerResult.sid,
        provider_status: providerResult.status
      });
    } catch (error) {
      results.push(failProviderMessage(state, message, error.message, now));
    }
  }

  return results;
}

async function handleTwilioWhatsAppRun(response) {
  const config = readTwilioWhatsAppConfig();
  const validation = validateTwilioWhatsAppConfig(config);

  if (!config.enabled) {
    return sendJson(response, 400, {
      ok: false,
      error: "Twilio WhatsApp sending is disabled",
      next_step: "Use the fake sender, or set TWILIO_WHATSAPP_ENABLED=true after sandbox setup"
    });
  }

  if (!validation.ok) {
    return sendJson(response, 400, {
      ok: false,
      error: "Twilio WhatsApp configuration is incomplete",
      missing: validation.missing
    });
  }

  const state = await readState();
  const results = await runTwilioWhatsAppSenderForState(state, config);

  await writeState(state);

  return sendJson(response, 200, {
    ok: true,
    results
  });
}

async function handleDashboard(response) {
  const html = await readTextFile(DASHBOARD_FILE);
  sendHtml(response, 200, html);
}

async function handleLanding(response) {
  const html = await readTextFile(LANDING_FILE);
  sendHtml(response, 200, html);
}

async function handleDashboardSummary(response) {
  const state = await readState();
  sendJson(response, 200, buildDashboardSummary(state));
}

async function handlePilotReadiness(response) {
  const state = await readState();
  const shopifyConfig = readShopifyConfig();
  const twilioConfig = readTwilioWhatsAppConfig();

  sendJson(response, 200, buildPilotReadiness(state, {
    shopifyConfig,
    shopifyConfigCheck: validateShopifyConfig(shopifyConfig),
    twilioConfig,
    twilioValidation: validateTwilioWhatsAppConfig(twilioConfig),
    manualPilotMode: MANUAL_PILOT_MODE,
    autoWorkerEnabled: AUTO_WORKER_ENABLED
  }));
}

async function handlePilotPackage(response) {
  const state = await readState();
  sendJson(response, 200, buildPilotPackage(state));
}

async function handleClientPilotPlan(response) {
  const state = await readState();
  const shopifyConfig = readShopifyConfig();

  sendJson(response, 200, buildClientPilotPlan(state, {
    shopifyConfig,
    manualPilotMode: MANUAL_PILOT_MODE,
    productionFlags: {
      deploymentReady: process.env.RecoverPilot_PRODUCTION_DEPLOYMENT_READY === "true",
      merchantAuthReady: process.env.RecoverPilot_MERCHANT_AUTH_READY === "true",
      privacyReady: process.env.RecoverPilot_PRIVACY_COMPLIANCE_READY === "true",
      billingReady: process.env.RecoverPilot_BILLING_READY === "true"
    }
  }));
}

async function handleProductionReadiness(response) {
  const state = await readState();
  const shopifyConfig = readShopifyConfig();
  const twilioConfig = readTwilioWhatsAppConfig();

  sendJson(response, 200, buildProductionReadiness(state, {
    shopifyConfig,
    shopifyConfigCheck: validateShopifyConfig(shopifyConfig),
    twilioConfig,
    twilioValidation: validateTwilioWhatsAppConfig(twilioConfig),
    manualPilotMode: MANUAL_PILOT_MODE,
    autoWorkerEnabled: AUTO_WORKER_ENABLED,
    productionFlags: {
      deploymentReady: process.env.RecoverPilot_PRODUCTION_DEPLOYMENT_READY === "true",
      merchantAuthReady: process.env.RecoverPilot_MERCHANT_AUTH_READY === "true",
      whatsappApproved: process.env.RecoverPilot_PRODUCTION_WHATSAPP_APPROVED === "true",
      databaseReady: process.env.RecoverPilot_PRODUCTION_DATABASE_READY === "true",
      privacyReady: process.env.RecoverPilot_PRIVACY_COMPLIANCE_READY === "true",
      webhookHygieneConfirmed: process.env.RecoverPilot_WEBHOOK_HYGIENE_CONFIRMED === "true",
      billingReady: process.env.RecoverPilot_BILLING_READY === "true"
    }
  }));
}

async function handleShopifyStatus(response) {
  const config = readShopifyConfig();
  const configCheck = validateShopifyConfig(config);
  const webhookCheck = validateWebhookRegistrationConfig(config);

  sendJson(response, 200, {
    ok: true,
    shopify: {
      configured: configCheck.ok,
      missing: configCheck.missing,
      app_url: config.appUrl,
      redirect_path: config.redirectPath,
      scopes: config.scopes,
      access_mode: config.accessMode,
      use_legacy_install_flow: config.useLegacyInstallFlow,
      webhook_registration: {
        ready: webhookCheck.ok,
        reason: webhookCheck.reason || null,
        subscriptions: DEFAULT_WEBHOOK_SUBSCRIPTIONS.map((subscription) => ({
          topic: subscription.topic,
          uri: buildWebhookCallbackUrl(config, subscription.path)
        }))
      }
    }
  });
}

async function handleShopifyInstallStart(request, response, parsedUrl) {
  const config = readShopifyConfig();
  const configCheck = validateShopifyConfig(config);

  if (!configCheck.ok) {
    return sendJson(response, 500, {
      ok: false,
      error: "Shopify configuration is incomplete",
      missing: configCheck.missing
    });
  }

  const shop = parsedUrl.searchParams.get("shop");
  if (!isValidShopDomain(shop)) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid Shopify shop domain",
      example: "fashion-store.myshopify.com"
    });
  }

  const state = createInstallNonce();
  saveInstallState(state, {
    shop,
    created_at: new Date().toISOString()
  });

  return sendRedirect(response, buildAuthorizeUrl(config, shop, state));
}

async function handleShopifyInstallCallback(response, parsedUrl) {
  const config = readShopifyConfig();
  const configCheck = validateShopifyConfig(config);

  if (!configCheck.ok) {
    return sendJson(response, 500, {
      ok: false,
      error: "Shopify configuration is incomplete",
      missing: configCheck.missing
    });
  }

  const query = Object.fromEntries(parsedUrl.searchParams.entries());
  const shop = query.shop;

  if (!isValidShopDomain(shop)) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid Shopify shop domain"
    });
  }

  if (!verifyShopifyQueryHmac(query, config.apiSecret)) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid Shopify callback HMAC"
    });
  }

  const installState = consumeInstallState(query.state);
  if (!installState || installState.shop !== shop) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid or expired Shopify install state"
    });
  }

  if (!query.code) {
    return sendJson(response, 400, {
      ok: false,
      error: "Missing Shopify authorization code"
    });
  }

  const tokenPayload = await exchangeAuthorizationCode(config, shop, query.code);
  const appState = await readState();
  const existingStore = appState.stores.find((item) => item.store_domain === shop);
  const storeId = existingStore?.store_id || `shop_${shop.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;

  const settings = updateCampaignSettings(appState, storeId, {});
  settings.store_domain = shop;

  const nextStore = {
    ...(existingStore || {}),
    store_id: storeId,
    store_name: existingStore?.store_name || shop.replace(".myshopify.com", ""),
    store_domain: shop,
    app_status: "installed",
    shopify_access_token: tokenPayload.access_token,
    shopify_scope: tokenPayload.scope || config.scopes.join(","),
    shopify_token_type: config.accessMode,
    shopify_refresh_token: tokenPayload.refresh_token || null,
    shopify_token_expires_at: tokenPayload.expires_in
      ? new Date(Date.now() + Number(tokenPayload.expires_in) * 1000).toISOString()
      : null,
    updated_at: new Date().toISOString()
  };

  const storeIndex = appState.stores.findIndex((item) => item.store_id === storeId);
  if (storeIndex === -1) {
    appState.stores.push(nextStore);
  } else {
    appState.stores[storeIndex] = nextStore;
  }

  await writeState(appState);

  return sendJson(response, 200, {
    ok: true,
    message: "Shopify install callback processed",
    store: {
      store_id: nextStore.store_id,
      store_domain: nextStore.store_domain,
      app_status: nextStore.app_status,
      shopify_scope: nextStore.shopify_scope
    }
  });
}

async function handleShopifyWebhookRegistration(response, parsedUrl) {
  const config = readShopifyConfig();
  const configCheck = validateShopifyConfig(config);

  if (!configCheck.ok) {
    return sendJson(response, 500, {
      ok: false,
      error: "Shopify configuration is incomplete",
      missing: configCheck.missing
    });
  }

  const shop = parsedUrl.searchParams.get("shop");
  if (!isValidShopDomain(shop)) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid Shopify shop domain",
      example: "fashion-store.myshopify.com"
    });
  }

  const state = await readState();
  const store = state.stores.find((item) => item.store_domain === shop);

  if (!store || store.app_status !== "installed" || !store.shopify_access_token) {
    return sendJson(response, 404, {
      ok: false,
      error: "Installed Shopify store with access token not found",
      shop
    });
  }

  let result;

  try {
    result = await registerDefaultWebhookSubscriptions(config, store);
  } catch (error) {
    result = {
      ok: false,
      reason: sanitizeProviderFailureReason(error.message),
      app_url: config.appUrl,
      subscriptions: []
    };
  }

  addActivity(
    state,
    result.ok ? "shopify_webhook_registration_completed" : "shopify_webhook_registration_blocked",
    result.ok ? `Shopify webhooks registered for ${shop}` : `Shopify webhook registration blocked for ${shop}`,
    {
      store_id: store.store_id,
      store_domain: shop,
      app_url: config.appUrl,
      reason: result.reason || null,
      subscriptions: result.subscriptions
    }
  );
  await writeState(state);

  return sendJson(response, result.ok ? 200 : 400, {
    ok: result.ok,
    result
  });
}

async function handleShopifyWebhookList(response, parsedUrl) {
  const shop = parsedUrl.searchParams.get("shop");

  if (!isValidShopDomain(shop)) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid Shopify shop domain",
      example: "fashion-store.myshopify.com"
    });
  }

  const state = await readState();
  const store = state.stores.find((item) => item.store_domain === shop);

  if (!store || store.app_status !== "installed" || !store.shopify_access_token) {
    return sendJson(response, 404, {
      ok: false,
      error: "Installed Shopify store with access token not found",
      shop
    });
  }

  try {
    const subscriptions = await listWebhookSubscriptions(shop, store.shopify_access_token);
    return sendJson(response, 200, {
      ok: true,
      shop,
      subscriptions
    });
  } catch (error) {
    const details = sanitizeProviderFailureReason(error.message);
    return sendJson(response, 502, {
      ok: false,
      error: "Could not list Shopify webhooks",
      details
    });
  }
}

function splitScopes(scopeString) {
  return String(scopeString || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function countStoreRows(state, storeId) {
  const conversions = state.conversions.filter((item) => item.store_id === storeId);

  return {
    abandoned_carts: state.carts.filter((item) => item.store_id === storeId).length,
    messages: state.messages.filter((item) => item.store_id === storeId).length,
    conversions: conversions.length,
    recovered_revenue: conversions.reduce((total, item) => total + Number(item.recovered_revenue || 0), 0)
  };
}

function buildRequiredWebhookStatus(config, subscriptions) {
  return DEFAULT_WEBHOOK_SUBSCRIPTIONS.map((subscription) => {
    const expectedUri = buildWebhookCallbackUrl(config, subscription.path);
    const match = subscriptions.find((item) => item.topic === subscription.topic && item.uri === expectedUri);

    return {
      topic: subscription.topic,
      uri: expectedUri,
      registered: Boolean(match),
      subscription_id: match?.id || null
    };
  });
}

async function handleShopifyIngestionStatus(response, parsedUrl) {
  const config = readShopifyConfig();
  const shop = parsedUrl.searchParams.get("shop");

  if (!isValidShopDomain(shop)) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid Shopify shop domain",
      example: "fashion-store.myshopify.com"
    });
  }

  const state = await readState();
  const store = state.stores.find((item) => item.store_domain === shop);

  if (!store) {
    return sendJson(response, 404, {
      ok: false,
      error: "Shopify store not found in local database",
      shop,
      next_step: `Install the app first: /auth/shopify/start?shop=${shop}`
    });
  }

  const scopes = splitScopes(store.shopify_scope);
  const hasAccessToken = Boolean(store.shopify_access_token);
  const appInstalled = store.app_status === "installed";
  let webhookSubscriptions = [];
  let webhookError = null;

  if (appInstalled && hasAccessToken) {
    try {
      webhookSubscriptions = await listWebhookSubscriptions(shop, store.shopify_access_token);
    } catch (error) {
      webhookError = sanitizeProviderFailureReason(error.message);
    }
  }

  const requiredWebhooks = buildRequiredWebhookStatus(config, webhookSubscriptions);
  const orderWebhookReady = requiredWebhooks.some((item) => {
    return ["ORDERS_CREATE", "ORDERS_PAID"].includes(item.topic) && item.registered;
  });
  const hasReadOrdersScope = scopes.includes("read_orders");
  const hasReadCustomersScope = scopes.includes("read_customers");
  const importRoute = `/shopify/abandoned-checkouts/import?shop=${shop}&limit=5`;

  return sendJson(response, 200, {
    ok: true,
    phase: "16",
    shop,
    store: {
      store_id: store.store_id,
      store_domain: store.store_domain,
      app_status: store.app_status || "unknown",
      has_access_token: hasAccessToken,
      scopes
    },
    routes: {
      import_abandoned_checkouts: `POST ${importRoute}`,
      list_webhooks: `/auth/shopify/webhooks?shop=${shop}`,
      register_webhooks: `POST /auth/shopify/register-webhooks?shop=${shop}`
    },
    local_counts: countStoreRows(state, store.store_id),
    webhook_subscriptions: {
      checked: appInstalled && hasAccessToken,
      required: requiredWebhooks,
      error: webhookError
    },
    readiness: {
      app_installed: appInstalled,
      access_token_saved: hasAccessToken,
      has_read_orders_scope: hasReadOrdersScope,
      has_read_customers_scope: hasReadCustomersScope,
      order_webhook_ready: orderWebhookReady,
      abandoned_checkout_import_ready: appInstalled && hasAccessToken && hasReadOrdersScope,
      phase_10_ready: appInstalled && hasAccessToken && hasReadOrdersScope,
      phase_16_ready_to_test: appInstalled && hasAccessToken && hasReadOrdersScope,
      strict_close_loop_ready: appInstalled && hasAccessToken && hasReadOrdersScope && orderWebhookReady
    },
    notes: [
      "Abandoned checkout import can still fail if Shopify protected customer data access is not approved.",
      "A result with zero imported checkouts is okay if the dev store has no abandoned checkouts yet.",
      "Order webhooks close the loop by mapping purchases back to known abandoned carts."
    ]
  });
}

async function handleShopifyAbandonedCheckoutImport(response, parsedUrl) {
  const shop = parsedUrl.searchParams.get("shop");
  const limit = Math.min(Number(parsedUrl.searchParams.get("limit") || 5), 25);

  if (!isValidShopDomain(shop)) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid Shopify shop domain",
      example: "fashion-store.myshopify.com"
    });
  }

  const state = await readState();
  const store = state.stores.find((item) => item.store_domain === shop);

  if (!store || store.app_status !== "installed" || !store.shopify_access_token) {
    return sendJson(response, 404, {
      ok: false,
      error: "Installed Shopify store with access token not found",
      shop
    });
  }

  try {
    const checkouts = await fetchAbandonedCheckouts(store, limit);
    const results = [];

    for (const checkout of checkouts) {
      const event = abandonedCheckoutToEvent(store, checkout);
      results.push(processAbandonedCartEvent(state, event).body);
    }

    addActivity(
      state,
      "shopify_abandoned_checkouts_imported",
      `Imported ${checkouts.length} abandoned checkout(s) from Shopify`,
      {
        store_id: store.store_id,
        store_domain: store.store_domain,
        imported: checkouts.length
      }
    );
    await writeState(state);

    return sendJson(response, 200, {
      ok: true,
      imported: checkouts.length,
      results
    });
  } catch (error) {
    const details = sanitizeProviderFailureReason(error.message);
    addActivity(
      state,
      "shopify_abandoned_checkouts_import_failed",
      "Shopify abandoned checkout import failed",
      {
        store_id: store.store_id,
        store_domain: store.store_domain,
        reason: details
      }
    );
    await writeState(state);

    return sendJson(response, 502, {
      ok: false,
      error: "Shopify abandoned checkout import failed",
      details
    });
  }
}

async function handleShopifyOrderImport(response, parsedUrl) {
  const shop = parsedUrl.searchParams.get("shop");
  const limit = Math.min(Number(parsedUrl.searchParams.get("limit") || 10), 50);

  if (!isValidShopDomain(shop)) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid Shopify shop domain",
      example: "fashion-store.myshopify.com"
    });
  }

  const state = await readState();
  const store = state.stores.find((item) => item.store_domain === shop);

  if (!store || store.app_status !== "installed" || !store.shopify_access_token) {
    return sendJson(response, 404, {
      ok: false,
      error: "Installed Shopify store with access token not found",
      shop
    });
  }

  try {
    const orders = await fetchOrders(store, limit);
    const results = [];

    for (const order of orders) {
      const result = processShopifyOrdersCreate(
        state,
        {
          topic: "orders/import",
          shop: store.store_domain,
          webhookId: `order_import_${order.id}`,
          apiVersion: process.env.SHOPIFY_ADMIN_API_VERSION || "2026-04"
        },
        order
      );

      results.push(result);
    }

    addActivity(
      state,
      "shopify_orders_imported",
      `Imported ${orders.length} Shopify order(s)`,
      {
        store_id: store.store_id,
        store_domain: store.store_domain,
        imported: orders.length,
        mapped: results.filter((item) => item.mapped_to_cart).length
      }
    );
    await writeState(state);

    return sendJson(response, 200, {
      ok: true,
      imported: orders.length,
      mapped: results.filter((item) => item.mapped_to_cart).length,
      credited: results.filter((item) => {
        return item.purchase_result?.conversion?.recovered_by_message;
      }).length,
      results
    });
  } catch (error) {
    const details = sanitizeProviderFailureReason(error.message);
    addActivity(
      state,
      "shopify_orders_import_failed",
      "Shopify order import failed",
      {
        store_id: store.store_id,
        store_domain: store.store_domain,
        reason: details
      }
    );
    await writeState(state);

    return sendJson(response, 502, {
      ok: false,
      error: "Shopify order import failed",
      details
    });
  }
}

async function handleDemoReset(response) {
  await resetState();
  sendJson(response, 200, {
    ok: true,
    message: "Demo state reset"
  });
}

async function handleDemoAbandonedCart(request, response) {
  const event = await readJsonFile(SAMPLE_ABANDONED_CART_FILE);
  return receiveAbandonedCartEvent(request, response, event);
}

async function handleDemoSameCartNewEvent(request, response) {
  const event = await readJsonFile(SAMPLE_ABANDONED_CART_FILE);
  event.event_id = "evt_demo_001_same_cart_second_event";
  event.cart.abandoned_at = new Date().toISOString();
  return receiveAbandonedCartEvent(request, response, event);
}

async function handleDemoNewCartSameCustomer(request, response) {
  const event = await readJsonFile(SAMPLE_ABANDONED_CART_FILE);
  event.event_id = "evt_demo_002_same_customer_new_cart";
  event.cart.cart_id = "cart_demo_002";
  event.cart.checkout_url = "https://demo-fashion-store.com/checkouts/cart_demo_002";
  event.cart.abandoned_at = new Date().toISOString();
  return receiveAbandonedCartEvent(request, response, event);
}

async function handleDemoNoConsentAbandonedCart(request, response) {
  const event = await readJsonFile(SAMPLE_NO_CONSENT_ABANDONED_CART_FILE);
  return receiveAbandonedCartEvent(request, response, event);
}

async function handleDemoCustomerOptOut(response) {
  const state = await readState();
  const result = processCustomerOptOut(state, "store_demo_fashion_001", "cus_demo_001");
  await writeState(state);
  return sendJson(response, result.statusCode, result.body);
}

async function handleDemoCampaignOff(response) {
  const state = await readState();
  const settings = updateCampaignSettings(state, "store_demo_fashion_001", {
    enabled: false
  });
  await writeState(state);

  sendJson(response, 200, {
    ok: true,
    message: "Demo campaign turned off",
    settings
  });
}

async function handleDemoMessageDue(response) {
  const state = await readState();
  const changed = makeScheduledMessagesDue(state);
  await writeState(state);
  sendJson(response, 200, {
    ok: true,
    changed
  });
}

async function handleDemoFailSend(response) {
  const state = await readState();
  const results = failNextWhatsAppMessage(state);
  await writeState(state);
  sendJson(response, 200, {
    ok: true,
    results
  });
}

async function handleDemoRetrySend(response) {
  const state = await readState();
  const results = retryNextFailedWhatsAppMessage(state);
  await writeState(state);
  sendJson(response, 200, {
    ok: true,
    results
  });
}

async function handleDemoPurchase(request, response) {
  const state = await readState();
  const message = state.messages.find((item) => item.cart_id === "cart_demo_001");
  const event = await readJsonFile(SAMPLE_PURCHASE_FILE);

  if (message?.sent_at) {
    const sentAt = new Date(message.sent_at);
    event.purchased_at = new Date(sentAt.getTime() + 5 * 60 * 1000).toISOString();
  }

  return receivePurchaseEvent(request, response, event);
}

async function handleDemoLatePurchase(request, response) {
  const state = await readState();
  const message = state.messages.find((item) => item.cart_id === "cart_demo_001");
  const event = await readJsonFile(SAMPLE_PURCHASE_FILE);
  const baseTime = message?.sent_at ? new Date(message.sent_at) : new Date();

  event.event_id = "evt_demo_purchase_late_001";
  event.order_id = "order_demo_late_001";
  event.purchased_at = new Date(baseTime.getTime() + 8 * 24 * 60 * 60 * 1000).toISOString();

  return receivePurchaseEvent(request, response, event);
}

async function handleCampaignSettingsUpdate(request, response) {
  let body;

  try {
    body = await readJsonRequest(request);
  } catch (error) {
    return sendJson(response, 400, {
      ok: false,
      error: "Invalid JSON body"
    });
  }

  const storeId = body.store_id || "store_demo_fashion_001";
  const state = await readState();
  const settings = updateCampaignSettings(state, storeId, body);
  await writeState(state);

  return sendJson(response, 200, {
    ok: true,
    settings
  });
}

async function handleShopifyWebhook(request, response, expectedTopic, processor) {
  const config = readShopifyConfig();
  const configCheck = validateShopifyConfig(config);

  if (!configCheck.ok) {
    return sendJson(response, 500, {
      ok: false,
      error: "Shopify configuration is incomplete",
      missing: configCheck.missing
    });
  }

  const rawBody = await readRequestBody(request);
  const validation = validateShopifyWebhookRequest(request, rawBody, config.apiSecret);

  if (!validation.ok) {
    return sendJson(response, validation.statusCode, {
      ok: false,
      error: validation.error
    });
  }

  if (validation.topic !== expectedTopic) {
    return sendJson(response, 400, {
      ok: false,
      error: `Unexpected Shopify webhook topic: ${validation.topic}`
    });
  }

  const state = await readState();

  if (validation.webhookId) {
    const duplicateEventId = buildWebhookReceiptEventId(validation.webhookId);
    const alreadyProcessed = state.events.find((item) => item.event_id === duplicateEventId);

    if (alreadyProcessed) {
      addActivity(
        state,
        "shopify_webhook_duplicate_ignored",
        `Duplicate Shopify webhook ignored for ${validation.topic}`,
        {
          topic: validation.topic,
          shop_domain: validation.shop,
          webhook_id: validation.webhookId
        }
      );
      await writeState(state);

      return sendJson(response, 200, {
        ok: true,
        duplicate: true,
        webhook: {
          topic: validation.topic,
          shop: validation.shop,
          webhook_id: validation.webhookId,
          api_version: validation.apiVersion || null
        }
      });
    }
  }

  const parsed = parseJsonSafely(rawBody);
  if (!parsed.ok) {
    return sendJson(response, 400, {
      ok: false,
      error: parsed.error
    });
  }

  const result = processor(state, validation, parsed.payload);
  recordWebhookReceipt(state, validation);
  await writeState(state);

  return sendJson(response, 200, {
    ok: true,
    webhook: {
      topic: validation.topic,
      shop: validation.shop,
      webhook_id: validation.webhookId || null,
      api_version: validation.apiVersion || null
    },
    result
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const parsedUrl = new URL(request.url, `http://localhost:${PORT}`);

    if (request.method === "GET" && parsedUrl.pathname === "/") {
      return handleDashboard(response);
    }

    if (request.method === "GET" && parsedUrl.pathname === "/landing") {
      return handleLanding(response);
    }

    if (request.method === "GET" && parsedUrl.pathname === "/auth/shopify/status") {
      return handleShopifyStatus(response);
    }

    if (request.method === "GET" && parsedUrl.pathname === "/auth/shopify/start") {
      return handleShopifyInstallStart(request, response, parsedUrl);
    }

    if (request.method === "GET" && parsedUrl.pathname === "/auth/shopify/callback") {
      return handleShopifyInstallCallback(response, parsedUrl);
    }

    if (request.method === "POST" && parsedUrl.pathname === "/auth/shopify/register-webhooks") {
      return handleShopifyWebhookRegistration(response, parsedUrl);
    }

    if (request.method === "GET" && parsedUrl.pathname === "/auth/shopify/webhooks") {
      return handleShopifyWebhookList(response, parsedUrl);
    }

    if (request.method === "GET" && parsedUrl.pathname === "/shopify/ingestion/status") {
      return handleShopifyIngestionStatus(response, parsedUrl);
    }

    if (request.method === "POST" && parsedUrl.pathname === "/shopify/abandoned-checkouts/import") {
      return handleShopifyAbandonedCheckoutImport(response, parsedUrl);
    }

    if (request.method === "POST" && parsedUrl.pathname === "/shopify/orders/import") {
      return handleShopifyOrderImport(response, parsedUrl);
    }

    if (request.method === "GET" && request.url === "/health") {
      return sendJson(response, 200, { ok: true, service: "retargeting-learning-prototype" });
    }

    if (request.method === "GET" && request.url === "/state") {
      return sendJson(response, 200, await readState());
    }

    if (request.method === "GET" && request.url === "/api/dashboard") {
      return handleDashboardSummary(response);
    }

    if (request.method === "GET" && request.url === "/pilot/readiness") {
      return handlePilotReadiness(response);
    }

    if (request.method === "GET" && request.url === "/pilot/package") {
      return handlePilotPackage(response);
    }

    if (request.method === "GET" && request.url === "/client-pilot/plan") {
      return handleClientPilotPlan(response);
    }

    if (request.method === "GET" && request.url === "/production/readiness") {
      return handleProductionReadiness(response);
    }

    if (request.method === "POST" && request.url === "/events/abandoned-cart") {
      return receiveAbandonedCartEvent(request, response);
    }

    if (request.method === "POST" && request.url === "/events/purchase") {
      return receivePurchaseEvent(request, response);
    }

    if (request.method === "POST" && request.url === "/webhooks/shopify/app-uninstalled") {
      return handleShopifyWebhook(request, response, "app/uninstalled", processShopifyAppUninstalled);
    }

    if (request.method === "POST" && request.url === "/webhooks/shopify/orders-create") {
      return handleShopifyWebhook(request, response, "orders/create", processShopifyOrdersCreate);
    }

    if (request.method === "POST" && request.url === "/webhooks/shopify/orders-paid") {
      return handleShopifyWebhook(request, response, "orders/paid", processShopifyOrdersCreate);
    }

    if (request.method === "POST" && request.url === "/scheduler/run") {
      return runAndSave(response, (state) => runScheduler(state, new Date(), { manualPilot: MANUAL_PILOT_MODE }));
    }

    if (request.method === "POST" && request.url === "/sender/fake-whatsapp/run") {
      return runAndSave(response, runFakeWhatsAppSender);
    }

    if (request.method === "POST" && request.url === "/sender/fake-whatsapp/fail") {
      return runAndSave(response, runFakeWhatsAppFailure);
    }

    if (request.method === "GET" && request.url === "/sender/twilio-whatsapp/status") {
      return handleTwilioWhatsAppStatus(response);
    }

    if (request.method === "POST" && request.url === "/sender/twilio-whatsapp/test") {
      return handleTwilioWhatsAppTestSend(request, response);
    }

    if (request.method === "POST" && request.url === "/sender/twilio-whatsapp/run") {
      return handleTwilioWhatsAppRun(response);
    }

    if (request.method === "POST" && request.url === "/sender/twilio-whatsapp/sync-status") {
      return handleTwilioWhatsAppSyncStatus(response);
    }

    if (request.method === "POST" && request.url === "/automation/run") {
      const results = await runAutomationCycle("manual");
      return sendJson(response, 200, {
        ok: true,
        ...results
      });
    }

    if (request.method === "GET" && request.url === "/automation/status") {
      return handleAutomationStatus(response);
    }

    if (request.method === "POST" && request.url === "/manual-pilot/messages/mark-sent") {
      return handleManualMessageMarkSent(request, response);
    }

    if (request.method === "POST" && request.url === "/self-trial/carts/mark-whatsapp-consent") {
      return handleSelfTrialConsentOverride(request, response);
    }

    if (request.method === "POST" && request.url === "/messages/retry") {
      return handleMessageRetry(request, response);
    }

    if (request.method === "POST" && request.url === "/demo/reset") {
      return handleDemoReset(response);
    }

    if (request.method === "POST" && request.url === "/demo/abandoned-cart") {
      return handleDemoAbandonedCart(request, response);
    }

    if (request.method === "POST" && request.url === "/demo/same-cart-new-event") {
      return handleDemoSameCartNewEvent(request, response);
    }

    if (request.method === "POST" && request.url === "/demo/new-cart-same-customer") {
      return handleDemoNewCartSameCustomer(request, response);
    }

    if (request.method === "POST" && request.url === "/demo/no-consent-cart") {
      return handleDemoNoConsentAbandonedCart(request, response);
    }

    if (request.method === "POST" && request.url === "/demo/customer-opt-out") {
      return handleDemoCustomerOptOut(response);
    }

    if (request.method === "POST" && request.url === "/demo/campaign-off") {
      return handleDemoCampaignOff(response);
    }

    if (request.method === "POST" && request.url === "/demo/message-due") {
      return handleDemoMessageDue(response);
    }

    if (request.method === "POST" && request.url === "/demo/fail-send") {
      return handleDemoFailSend(response);
    }

    if (request.method === "POST" && request.url === "/demo/retry-send") {
      return handleDemoRetrySend(response);
    }

    if (request.method === "POST" && request.url === "/demo/purchase") {
      return handleDemoPurchase(request, response);
    }

    if (request.method === "POST" && request.url === "/demo/late-purchase") {
      return handleDemoLatePurchase(request, response);
    }

    if (request.method === "POST" && request.url === "/campaign/settings") {
      return handleCampaignSettingsUpdate(request, response);
    }

    sendJson(response, 404, {
      ok: false,
      error: "Route not found"
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: "Internal server error",
      details: error.message
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`RecoverPilot demo running at http://${HOST}:${PORT}`);
  console.log(`Open http://localhost:${PORT} for the dashboard`);
  if (AUTO_WORKER_ENABLED) {
    console.log(`Auto worker enabled. It checks every ${AUTO_WORKER_INTERVAL_MS}ms.`);
  }
});

if (AUTO_WORKER_ENABLED) {
  setInterval(() => {
    runAutomationCycle("auto_worker").catch((error) => {
      console.error("Auto worker failed:", error.message);
    });
  }, AUTO_WORKER_INTERVAL_MS);
}
