function upsertById(items, idField, nextItem) {
  const index = items.findIndex((item) => item[idField] === nextItem[idField]);
  if (index === -1) {
    items.push(nextItem);
    return nextItem;
  }

  items[index] = { ...items[index], ...nextItem };
  return items[index];
}

const DEFAULT_MESSAGE_TEMPLATE = "Hi {{first_name}}, you left items in your cart. Complete your order here: {{checkout_url}}";
const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 7;
const PENDING_MESSAGE_STATUSES = ["scheduled", "ready_to_send", "manual_send_needed"];
const SENT_MESSAGE_STATUSES = ["fake_sent", "sent", "manual_sent"];

function defaultCampaignSettings(storeId) {
  return {
    store_id: storeId,
    enabled: true,
    channel: "whatsapp",
    delay_minutes: 60,
    attribution_window_days: DEFAULT_ATTRIBUTION_WINDOW_DAYS,
    max_messages_per_cart: 1,
    message_template: DEFAULT_MESSAGE_TEMPLATE
  };
}

function ensureStateShape(state) {
  state.events ||= [];
  state.stores ||= [];
  state.customers ||= [];
  state.carts ||= [];
  state.messages ||= [];
  state.conversions ||= [];
  state.campaign_settings ||= [];
  state.activity ||= [];
  return state;
}

function addActivity(state, type, message, details = {}, now = new Date()) {
  ensureStateShape(state);
  state.activity.push({
    activity_id: `act_${now.getTime()}_${state.activity.length + 1}`,
    type,
    message,
    details,
    created_at: now.toISOString()
  });
}

function getCampaignSettings(state, storeId) {
  ensureStateShape(state);
  const existing = state.campaign_settings.find((item) => item.store_id === storeId);
  if (existing) {
    return {
      ...defaultCampaignSettings(storeId),
      ...existing
    };
  }

  const settings = defaultCampaignSettings(storeId);
  state.campaign_settings.push({
    ...settings,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  return settings;
}

function updateCampaignSettings(state, storeId, nextSettings, now = new Date()) {
  ensureStateShape(state);
  const current = getCampaignSettings(state, storeId);
  const index = state.campaign_settings.findIndex((item) => item.store_id === storeId);
  const updated = {
    ...current,
    ...nextSettings,
    store_id: storeId,
    delay_minutes: Number(nextSettings.delay_minutes ?? current.delay_minutes),
    attribution_window_days: Number(nextSettings.attribution_window_days ?? current.attribution_window_days),
    max_messages_per_cart: Number(nextSettings.max_messages_per_cart ?? current.max_messages_per_cart),
    enabled: Boolean(nextSettings.enabled ?? current.enabled),
    updated_at: now.toISOString()
  };

  if (index === -1) {
    state.campaign_settings.push(updated);
  } else {
    state.campaign_settings[index] = updated;
  }

  updated.unsent_messages_updated = updateUnsentMessagePreviews(state, storeId, updated, now);
  addActivity(
    state,
    "campaign_settings_updated",
    `Campaign settings updated for ${storeId}`,
    {
      store_id: storeId,
      enabled: updated.enabled,
      delay_minutes: updated.delay_minutes,
      attribution_window_days: updated.attribution_window_days,
      unsent_messages_updated: updated.unsent_messages_updated
    },
    now
  );

  return updated;
}

function renderMessageTemplate(template, event) {
  return renderTemplate(template, {
    first_name: event.customer.first_name,
    checkout_url: event.cart.checkout_url,
    store_name: event.store.store_name,
    cart_value: event.cart.cart_value
  });
}

function renderTemplate(template, values) {
  return template
    .replaceAll("{{first_name}}", values.first_name || "there")
    .replaceAll("{{checkout_url}}", values.checkout_url || "")
    .replaceAll("{{store_name}}", values.store_name || "")
    .replaceAll("{{cart_value}}", String(values.cart_value ?? ""));
}

function updateUnsentMessagePreviews(state, storeId, settings, now = new Date()) {
  let changed = 0;

  for (const message of state.messages) {
    if (message.store_id !== storeId) {
      continue;
    }

    if (!PENDING_MESSAGE_STATUSES.includes(message.status)) {
      continue;
    }

    const store = state.stores.find((item) => item.store_id === message.store_id);
    const customer = state.customers.find((item) => item.customer_id === message.customer_id);
    const cart = state.carts.find((item) => item.cart_id === message.cart_id);

    if (!store || !customer || !cart) {
      continue;
    }

    message.message_preview = renderTemplate(settings.message_template, {
      first_name: customer.first_name,
      checkout_url: cart.checkout_url,
      store_name: store.store_name,
      cart_value: cart.cart_value
    });
    message.channel = settings.channel;
    message.updated_at = now.toISOString();
    changed += 1;
  }

  return changed;
}

function cancelPendingCustomerMessages(state, customerId, reason, now = new Date()) {
  let changed = 0;

  for (const message of state.messages) {
    if (message.customer_id !== customerId) {
      continue;
    }

    if (!PENDING_MESSAGE_STATUSES.includes(message.status)) {
      continue;
    }

    message.status = "cancelled";
    message.cancelled_at = now.toISOString();
    message.cancel_reason = reason;
    message.updated_at = now.toISOString();
    changed += 1;
  }

  return changed;
}

function processCustomerOptOut(state, storeId, customerId, now = new Date()) {
  ensureStateShape(state);
  const customer = state.customers.find((item) => {
    return item.store_id === storeId && item.customer_id === customerId;
  });

  if (!customer) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: "Customer not found"
      }
    };
  }

  customer.whatsapp_consent = false;
  customer.whatsapp_opted_out = true;
  customer.opted_out_at = now.toISOString();
  customer.updated_at = now.toISOString();

  const cancelledMessages = cancelPendingCustomerMessages(
    state,
    customerId,
    "Customer opted out of WhatsApp",
    now
  );

  addActivity(
    state,
    "customer_opted_out",
    `${customer.first_name || "Customer"} opted out of WhatsApp messages`,
    {
      store_id: storeId,
      customer_id: customerId,
      cancelled_messages: cancelledMessages
    },
    now
  );

  return {
    statusCode: 200,
    body: {
      ok: true,
      customer,
      cancelled_messages: cancelledMessages
    }
  };
}

function processSelfTrialConsentOverride(state, cartId, now = new Date()) {
  ensureStateShape(state);

  const cart = state.carts.find((item) => item.cart_id === cartId);
  if (!cart) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: "Cart not found"
      }
    };
  }

  if (cart.status === "purchased") {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: "Cannot override consent for a purchased cart"
      }
    };
  }

  const customer = state.customers.find((item) => {
    return item.customer_id === cart.customer_id && item.store_id === cart.store_id;
  });
  if (!customer) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: "Customer not found for this cart"
      }
    };
  }

  if (customer.whatsapp_opted_out) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: "Cannot override consent because customer opted out"
      }
    };
  }

  const store = state.stores.find((item) => item.store_id === cart.store_id);
  const settings = getCampaignSettings(state, cart.store_id);
  if (!settings.enabled) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: "Campaign is turned off"
      }
    };
  }

  customer.whatsapp_consent = true;
  customer.whatsapp_consent_source = "self_trial_manual_confirmation";
  customer.whatsapp_consent_confirmed_at = now.toISOString();
  customer.updated_at = now.toISOString();

  const messagePreview = renderTemplate(settings.message_template, {
    first_name: customer.first_name,
    checkout_url: cart.checkout_url,
    store_name: store?.store_name || store?.store_domain || "",
    cart_value: cart.cart_value
  });

  let message = state.messages.find((item) => item.cart_id === cart.cart_id);
  if (!message) {
    message = {
      message_id: `msg_${cart.cart_id}`,
      event_id: `self_trial_consent_${cart.cart_id}`,
      store_id: cart.store_id,
      customer_id: customer.customer_id,
      cart_id: cart.cart_id,
      channel: settings.channel,
      status: "ready_to_send",
      scheduled_at: now.toISOString(),
      ready_at: now.toISOString(),
      send_attempts: 0,
      message_preview: messagePreview,
      consent_override: true,
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    };
    state.messages.push(message);
  } else if (!SENT_MESSAGE_STATUSES.includes(message.status)) {
    message.status = "ready_to_send";
    message.ready_at = now.toISOString();
    message.failure_reason = null;
    message.cancel_reason = null;
    message.message_preview = messagePreview;
    message.consent_override = true;
    message.updated_at = now.toISOString();
  }

  addActivity(
    state,
    "self_trial_whatsapp_consent_confirmed",
    `Self-trial WhatsApp consent manually confirmed for ${customer.first_name || "customer"}`,
    {
      cart_id: cart.cart_id,
      customer_id: customer.customer_id,
      message_id: message.message_id,
      reason: "Founder confirmed this is a self-trial test contact"
    },
    now
  );

  return {
    statusCode: 200,
    body: {
      ok: true,
      customer,
      message,
      next_step: "Send the prepared recovery message, then complete the checkout after the message is sent"
    }
  };
}

function failMessage(state, message, failureReason, now = new Date()) {
  message.status = "failed";
  message.failure_reason = failureReason;
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
      reason: failureReason
    },
    now
  );

  return {
    message_id: message.message_id,
    status: "failed",
    reason: failureReason
  };
}

function sendReadyMessage(state, message, customer, cart, now = new Date()) {
  const fakeSendLog = `FAKE WHATSAPP to ${customer.phone}: ${message.message_preview}`;

  message.status = "fake_sent";
  message.send_attempts = (Number(message.send_attempts) || 0) + 1;
  message.failure_reason = null;
  message.failed_at = null;
  message.fake_provider_message_id = `fake_whatsapp_${message.message_id}`;
  message.fake_send_log = fakeSendLog;
  message.sent_at = now.toISOString();
  message.updated_at = now.toISOString();
  addActivity(
    state,
    "fake_whatsapp_sent",
    `Fake WhatsApp sent to ${customer.first_name || "customer"}`,
    {
      message_id: message.message_id,
      cart_id: message.cart_id,
      phone: customer.phone,
      send_attempts: message.send_attempts
    },
    now
  );

  return {
    message_id: message.message_id,
    status: "fake_sent",
    fake_send_log: fakeSendLog,
    send_attempts: message.send_attempts
  };
}

function runFakeWhatsAppFailure(state, failureReason = "Fake WhatsApp provider rejected the message", now = new Date()) {
  ensureStateShape(state);
  const results = [];

  for (const message of state.messages) {
    if (message.status !== "ready_to_send") {
      continue;
    }

    results.push(failMessage(state, message, failureReason, now));
  }

  return results;
}

function failNextWhatsAppMessage(state, failureReason = "Fake WhatsApp provider rejected the message", now = new Date()) {
  ensureStateShape(state);
  const message = state.messages.find((item) => {
    return ["ready_to_send", "scheduled"].includes(item.status);
  });

  if (!message) {
    return [];
  }

  if (message.status === "scheduled") {
    message.status = "ready_to_send";
    message.scheduled_at = now.toISOString();
    message.ready_at = now.toISOString();
    message.updated_at = now.toISOString();
    addActivity(
      state,
      "message_ready",
      "Scheduled message is ready to send",
      {
        message_id: message.message_id,
        cart_id: message.cart_id
      },
      now
    );
  }

  return [failMessage(state, message, failureReason, now)];
}

function retryNextFailedWhatsAppMessage(state, maxAttempts = 2, now = new Date()) {
  ensureStateShape(state);
  const message = state.messages.find((item) => item.status === "failed");

  if (!message) {
    return [];
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
    return [
      {
        message_id: message.message_id,
        status: "retry_blocked",
        reason: "Max send attempts reached"
      }
    ];
  }

  const customer = state.customers.find((item) => item.customer_id === message.customer_id);
  const cart = state.carts.find((item) => item.cart_id === message.cart_id);

  if (!customer) {
    return [failMessage(state, message, "Customer not found", now)];
  }

  if (!cart) {
    return [failMessage(state, message, "Cart not found", now)];
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
        customer_id: message.customer_id
      },
      now
    );
    return [
      {
        message_id: message.message_id,
        status: "cancelled",
        reason: message.cancel_reason
      }
    ];
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
        cart_id: message.cart_id
      },
      now
    );
    return [
      {
        message_id: message.message_id,
        status: "cancelled",
        reason: message.cancel_reason
      }
    ];
  }

  message.status = "ready_to_send";
  message.retry_started_at = now.toISOString();
  message.updated_at = now.toISOString();
  addActivity(
    state,
    "message_retry_started",
    "Retry started for failed WhatsApp message",
    {
      message_id: message.message_id,
      cart_id: message.cart_id,
      next_attempt: sendAttempts + 1
    },
    now
  );

  return [sendReadyMessage(state, message, customer, cart, now)];
}

function calculateAttribution(message, purchaseEvent, settings) {
  const windowDays = Number(settings.attribution_window_days) || DEFAULT_ATTRIBUTION_WINDOW_DAYS;

  if (!message || !SENT_MESSAGE_STATUSES.includes(message.status)) {
    return {
      recoveredByMessage: false,
      reason: "No sent recovery message",
      windowDays,
      messageSentAt: message?.sent_at || null
    };
  }

  if (!message.sent_at) {
    return {
      recoveredByMessage: false,
      reason: "Message has no sent time",
      windowDays,
      messageSentAt: null
    };
  }

  const sentAt = new Date(message.sent_at);
  const purchasedAt = new Date(purchaseEvent.purchased_at);

  if (Number.isNaN(sentAt.getTime()) || Number.isNaN(purchasedAt.getTime())) {
    return {
      recoveredByMessage: false,
      reason: "Invalid attribution timestamp",
      windowDays,
      messageSentAt: message.sent_at
    };
  }

  if (purchasedAt < sentAt) {
    return {
      recoveredByMessage: false,
      reason: "Purchase happened before recovery message was sent",
      windowDays,
      messageSentAt: message.sent_at
    };
  }

  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const windowEndsAt = new Date(sentAt.getTime() + windowMs);

  if (purchasedAt > windowEndsAt) {
    return {
      recoveredByMessage: false,
      reason: "Purchase happened outside attribution window",
      windowDays,
      messageSentAt: message.sent_at
    };
  }

  return {
    recoveredByMessage: true,
    reason: `Purchase happened within ${windowDays}-day attribution window`,
    windowDays,
    messageSentAt: message.sent_at
  };
}

function createScheduledMessage(event, settings, now = new Date()) {
  const delayMs = settings.delay_minutes * 60 * 1000;
  const scheduledAt = new Date(now.getTime() + delayMs).toISOString();

  return {
    message_id: `msg_${event.cart.cart_id}`,
    event_id: event.event_id,
    store_id: event.store.store_id,
    customer_id: event.customer.customer_id,
    cart_id: event.cart.cart_id,
    channel: settings.channel,
    status: "scheduled",
    scheduled_at: scheduledAt,
    send_attempts: 0,
    message_preview: renderMessageTemplate(settings.message_template, event),
    created_at: now.toISOString()
  };
}

function processAbandonedCartEvent(state, event, now = new Date()) {
  ensureStateShape(state);
  const existingEvent = state.events.find((item) => item.event_id === event.event_id);

  if (existingEvent) {
    addActivity(
      state,
      "duplicate_event_ignored",
      "Duplicate abandoned-cart event ignored",
      {
        event_id: event.event_id,
        cart_id: event.cart?.cart_id
      },
      now
    );
    return {
      statusCode: 200,
      body: {
        ok: true,
        duplicate: true,
        message: "This event was already processed",
        event_id: event.event_id
      }
    };
  }

  const receivedAt = now.toISOString();

  state.events.push({
    event_id: event.event_id,
    event_type: event.event_type,
    received_at: receivedAt
  });
  addActivity(
    state,
    "abandoned_cart_received",
    `Abandoned cart received for ${event.customer.first_name || "customer"}`,
    {
      event_id: event.event_id,
      store_id: event.store.store_id,
      cart_id: event.cart.cart_id,
      cart_value: event.cart.cart_value,
      currency: event.cart.currency
    },
    now
  );

  upsertById(state.stores, "store_id", {
    store_id: event.store.store_id,
    store_name: event.store.store_name,
    store_domain: event.store.store_domain,
    updated_at: receivedAt
  });

  const existingCustomer = state.customers.find((item) => {
    return item.store_id === event.store.store_id && item.customer_id === event.customer.customer_id;
  });
  const customerOptedOut = Boolean(existingCustomer?.whatsapp_opted_out);

  upsertById(state.customers, "customer_id", {
    customer_id: event.customer.customer_id,
    store_id: event.store.store_id,
    first_name: event.customer.first_name,
    phone: event.customer.phone,
    email: event.customer.email,
    whatsapp_consent: customerOptedOut ? false : Boolean(event.customer.whatsapp_consent),
    whatsapp_opted_out: customerOptedOut,
    opted_out_at: existingCustomer?.opted_out_at || null,
    updated_at: receivedAt
  });

  upsertById(state.carts, "cart_id", {
    cart_id: event.cart.cart_id,
    store_id: event.store.store_id,
    customer_id: event.customer.customer_id,
    checkout_url: event.cart.checkout_url,
    checkout_token: event.cart.checkout_token || null,
    cart_token: event.cart.cart_token || null,
    currency: event.cart.currency,
    cart_value: event.cart.cart_value,
    items: event.cart.items || [],
    abandoned_at: event.cart.abandoned_at,
    status: event.cart.status,
    updated_at: receivedAt
  });

  let message = null;
  const existingMessage = state.messages.find((item) => item.cart_id === event.cart.cart_id);
  const settings = getCampaignSettings(state, event.store.store_id);

  if (!settings.enabled) {
    message = {
      status: "not_scheduled",
      reason: "Campaign is turned off"
    };
    addActivity(
      state,
      "message_not_scheduled",
      "Message not scheduled because campaign is off",
      {
        cart_id: event.cart.cart_id,
        reason: message.reason
      },
      now
    );
  } else if (customerOptedOut) {
    message = {
      status: "not_scheduled",
      reason: "Customer has opted out of WhatsApp"
    };
    addActivity(
      state,
      "message_not_scheduled",
      "Message not scheduled because customer opted out",
      {
        cart_id: event.cart.cart_id,
        customer_id: event.customer.customer_id,
        reason: message.reason
      },
      now
    );
  } else if (!event.customer.whatsapp_consent) {
    message = {
      status: "not_scheduled",
      reason: "Customer does not have WhatsApp consent"
    };
    addActivity(
      state,
      "message_not_scheduled",
      "Message not scheduled because WhatsApp consent is missing",
      {
        cart_id: event.cart.cart_id,
        reason: message.reason
      },
      now
    );
  } else if (existingMessage) {
    message = {
      status: "not_scheduled",
      reason: "A message already exists for this cart"
    };
    addActivity(
      state,
      "message_limit_reached",
      "Message not scheduled because this cart already has a message",
      {
        cart_id: event.cart.cart_id,
        existing_message_id: existingMessage.message_id,
        reason: message.reason
      },
      now
    );
  } else {
    message = createScheduledMessage(event, settings, now);
    state.messages.push(message);
    addActivity(
      state,
      "message_scheduled",
      `WhatsApp message scheduled for ${event.customer.first_name || "customer"}`,
      {
        message_id: message.message_id,
        cart_id: event.cart.cart_id,
        scheduled_at: message.scheduled_at
      },
      now
    );
  }

  return {
    statusCode: 201,
    body: {
      ok: true,
      event_id: event.event_id,
      cart_id: event.cart.cart_id,
      message
    }
  };
}

function processPurchaseEvent(state, event, now = new Date()) {
  ensureStateShape(state);
  const existingEvent = state.events.find((item) => item.event_id === event.event_id);

  if (existingEvent) {
    addActivity(
      state,
      "duplicate_event_ignored",
      "Duplicate purchase event ignored",
      {
        event_id: event.event_id,
        cart_id: event.cart_id,
        order_id: event.order_id
      },
      now
    );
    return {
      statusCode: 200,
      body: {
        ok: true,
        duplicate: true,
        message: "This purchase event was already processed",
        event_id: event.event_id
      }
    };
  }

  const cart = state.carts.find((item) => item.cart_id === event.cart_id && item.store_id === event.store_id);
  if (!cart) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: "Cart not found for this store"
      }
    };
  }

  const existingConversion = state.conversions.find((item) => item.order_id === event.order_id);
  if (existingConversion) {
    return {
      statusCode: 200,
      body: {
        ok: true,
        duplicate: true,
        message: "This order was already recorded as a conversion",
        conversion: existingConversion
      }
    };
  }

  const processedAt = now.toISOString();
  const message = state.messages.find((item) => item.cart_id === event.cart_id);
  const settings = getCampaignSettings(state, event.store_id);
  const attribution = calculateAttribution(message, event, settings);

  cart.status = "purchased";
  cart.purchased_at = event.purchased_at;
  cart.order_id = event.order_id;
  cart.updated_at = processedAt;

  state.events.push({
    event_id: event.event_id,
    event_type: event.event_type,
    received_at: processedAt
  });
  addActivity(
    state,
    "purchase_received",
    `Purchase recorded for ${event.order_value} ${event.currency}`,
    {
      event_id: event.event_id,
      cart_id: event.cart_id,
      order_id: event.order_id,
      order_value: event.order_value,
      currency: event.currency
    },
    now
  );

  const conversion = {
    conversion_id: `conv_${event.order_id}`,
    event_id: event.event_id,
    store_id: event.store_id,
    cart_id: event.cart_id,
    customer_id: cart.customer_id,
    message_id: message?.message_id || null,
    order_id: event.order_id,
    recovered_revenue: attribution.recoveredByMessage ? event.order_value : 0,
    currency: event.currency,
    recovered_by_message: attribution.recoveredByMessage,
    attribution_status: attribution.recoveredByMessage ? "credited" : "not_credited",
    attribution_reason: attribution.reason,
    attribution_window_days: attribution.windowDays,
    message_sent_at: attribution.messageSentAt,
    purchased_at: event.purchased_at,
    created_at: processedAt
  };

  state.conversions.push(conversion);
  addActivity(
    state,
    "conversion_recorded",
    `Recovered revenue recorded: ${conversion.recovered_revenue} ${conversion.currency}`,
    {
      conversion_id: conversion.conversion_id,
      cart_id: conversion.cart_id,
      order_id: conversion.order_id,
      recovered_revenue: conversion.recovered_revenue,
      currency: conversion.currency,
      attribution_status: conversion.attribution_status,
      attribution_reason: conversion.attribution_reason
    },
    now
  );

  return {
    statusCode: 201,
    body: {
      ok: true,
      cart_id: event.cart_id,
      cart_status: cart.status,
      conversion
    }
  };
}

function runScheduler(state, now = new Date(), options = {}) {
  ensureStateShape(state);
  const results = [];
  const readyStatus = options.manualPilot ? "manual_send_needed" : "ready_to_send";
  const activityType = options.manualPilot ? "manual_send_needed" : "message_ready";
  const activityMessage = options.manualPilot
    ? "Scheduled message is ready for manual WhatsApp send"
    : "Scheduled message is ready to send";

  for (const message of state.messages) {
    if (message.status !== "scheduled") {
      continue;
    }

    const scheduledAt = new Date(message.scheduled_at);
    if (Number.isNaN(scheduledAt.getTime())) {
      message.status = "failed";
      message.failure_reason = "Invalid scheduled_at value";
      message.updated_at = now.toISOString();
      results.push({
        message_id: message.message_id,
        status: "failed",
        reason: message.failure_reason
      });
      continue;
    }

    if (scheduledAt > now) {
      results.push({
        message_id: message.message_id,
        status: "waiting",
        scheduled_at: message.scheduled_at
      });
      continue;
    }

    const cart = state.carts.find((item) => item.cart_id === message.cart_id);
    if (!cart) {
      message.status = "failed";
      message.failure_reason = "Cart not found";
      message.updated_at = now.toISOString();
      addActivity(
        state,
        "message_failed",
        "Message failed because cart was not found",
        {
          message_id: message.message_id,
          cart_id: message.cart_id
        },
        now
      );
      results.push({
        message_id: message.message_id,
        status: "failed",
        reason: message.failure_reason
      });
      continue;
    }

    if (cart.status === "purchased") {
      message.status = "cancelled";
      message.cancelled_at = now.toISOString();
      message.cancel_reason = "Cart was already purchased";
      message.updated_at = now.toISOString();
      addActivity(
        state,
        "message_cancelled",
        "Message cancelled because cart was already purchased",
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

    message.status = readyStatus;
    message.ready_at = now.toISOString();
    message.updated_at = now.toISOString();
    addActivity(
      state,
      activityType,
      activityMessage,
      {
        message_id: message.message_id,
        cart_id: message.cart_id
      },
      now
    );
    results.push({
      message_id: message.message_id,
      status: readyStatus,
      message_preview: message.message_preview
    });
  }

  return results;
}

function runFakeWhatsAppSender(state, now = new Date()) {
  ensureStateShape(state);
  const results = [];

  for (const message of state.messages) {
    if (message.status !== "ready_to_send") {
      continue;
    }

    const customer = state.customers.find((item) => item.customer_id === message.customer_id);
    const cart = state.carts.find((item) => item.cart_id === message.cart_id);

    if (!customer) {
      message.status = "failed";
      message.failure_reason = "Customer not found";
      message.updated_at = now.toISOString();
      addActivity(
        state,
        "message_failed",
        "Message failed because customer was not found",
        {
          message_id: message.message_id,
          customer_id: message.customer_id
        },
        now
      );
      results.push({
        message_id: message.message_id,
        status: "failed",
        reason: message.failure_reason
      });
      continue;
    }

    if (!cart) {
      message.status = "failed";
      message.failure_reason = "Cart not found";
      message.updated_at = now.toISOString();
      addActivity(
        state,
        "message_failed",
        "Message failed because cart was not found",
        {
          message_id: message.message_id,
          cart_id: message.cart_id
        },
        now
      );
      results.push({
        message_id: message.message_id,
        status: "failed",
        reason: message.failure_reason
      });
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
        "Message cancelled because WhatsApp consent is missing",
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
        "Message cancelled because cart was purchased before sending",
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

    results.push(sendReadyMessage(state, message, customer, cart, now));
  }

  return results;
}

function makeScheduledMessagesDue(state, now = new Date()) {
  ensureStateShape(state);
  const oneMinuteAgo = new Date(now.getTime() - 60_000).toISOString();
  let changed = 0;

  for (const message of state.messages) {
    if (message.status === "scheduled") {
      message.scheduled_at = oneMinuteAgo;
      message.updated_at = now.toISOString();
      changed += 1;
    }
  }

  if (changed > 0) {
    addActivity(
      state,
      "messages_marked_due",
      `${changed} scheduled message(s) marked as due for demo`,
      { changed },
      now
    );
  }

  return changed;
}

module.exports = {
  PENDING_MESSAGE_STATUSES,
  SENT_MESSAGE_STATUSES,
  defaultCampaignSettings,
  addActivity,
  calculateAttribution,
  ensureStateShape,
  getCampaignSettings,
  failNextWhatsAppMessage,
  makeScheduledMessagesDue,
  processCustomerOptOut,
  processSelfTrialConsentOverride,
  processAbandonedCartEvent,
  processPurchaseEvent,
  retryNextFailedWhatsAppMessage,
  runFakeWhatsAppFailure,
  runFakeWhatsAppSender,
  runScheduler,
  updateCampaignSettings
};
