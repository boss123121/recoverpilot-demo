const { sanitizeProviderFailureReason } = require("./sanitize");

function latestActivityForCart(state, cartId, types) {
  return (state.activity || []).slice().reverse().find((item) => {
    return types.includes(item.type) && item.details?.cart_id === cartId;
  });
}

function buildAuditRows(state, storeId = null) {
  const rows = [];

  for (const cart of state.carts.filter((item) => !storeId || item.store_id === storeId)) {
    const customer = state.customers.find((item) => item.customer_id === cart.customer_id);
    const message = state.messages.find((item) => item.cart_id === cart.cart_id);
    const blockedActivity = latestActivityForCart(state, cart.cart_id, [
      "message_not_scheduled",
      "message_limit_reached",
      "message_cancelled",
      "message_failed"
    ]);

    if (message) {
      rows.push({
        subject: cart.cart_id,
        customer_name: customer?.first_name || "Unknown",
        decision: "Message decision",
        result: message.status,
        reason: message.failure_reason
          ? sanitizeProviderFailureReason(message.failure_reason)
          : message.cancel_reason || "Message exists for this cart"
      });
    } else if (blockedActivity) {
      rows.push({
        subject: cart.cart_id,
        customer_name: customer?.first_name || "Unknown",
        decision: "Message decision",
        result: "not_scheduled",
        reason: sanitizeProviderFailureReason(blockedActivity.details?.reason || blockedActivity.message)
      });
    } else {
      rows.push({
        subject: cart.cart_id,
        customer_name: customer?.first_name || "Unknown",
        decision: "Message decision",
        result: "no_message",
        reason: "No message decision recorded yet"
      });
    }
  }

  for (const conversion of state.conversions.filter((item) => !storeId || item.store_id === storeId)) {
    rows.push({
      subject: conversion.order_id,
      customer_name: conversion.customer_id,
      decision: "Revenue attribution",
      result: conversion.attribution_status || (conversion.recovered_by_message ? "credited" : "not_credited"),
      reason: conversion.attribution_reason || "No attribution reason recorded"
    });
  }

  return rows;
}

function splitScopes(scopeString) {
  return String(scopeString || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildSafeStoreRows(state) {
  return state.stores.map((store) => ({
    store_id: store.store_id,
    store_name: store.store_name || store.store_domain || "Unknown store",
    store_domain: store.store_domain || "",
    app_status: store.app_status || "unknown",
    has_shopify_access_token: Boolean(store.shopify_access_token),
    shopify_scope: store.shopify_scope || "",
    shopify_scopes: splitScopes(store.shopify_scope),
    updated_at: store.updated_at || null
  }));
}

function buildDashboardSummary(state) {
  state.campaign_settings ||= [];
  const stores = buildSafeStoreRows(state);
  const activeStore = stores.find((store) => {
    return store.app_status === "installed" && store.has_shopify_access_token;
  }) || stores[0] || null;
  const activeStoreId = activeStore?.store_id || null;
  const storeCarts = state.carts.filter((cart) => !activeStoreId || cart.store_id === activeStoreId);
  const storeMessages = state.messages.filter((message) => !activeStoreId || message.store_id === activeStoreId);
  const storeConversions = state.conversions.filter((conversion) => !activeStoreId || conversion.store_id === activeStoreId);
  const recoveredRevenue = storeConversions.reduce((total, conversion) => {
    return total + (Number(conversion.recovered_revenue) || 0);
  }, 0);

  return {
    stores,
    active_store: activeStore,
    metrics: {
      stores: state.stores.length,
      abandoned_carts: storeCarts.length,
      messages: storeMessages.length,
      conversions: storeConversions.length,
      recovered_revenue: recoveredRevenue,
      currency: storeConversions[0]?.currency || storeCarts[0]?.currency || "USD"
    },
    campaign_settings: state.campaign_settings,
    carts: storeCarts.map((cart) => {
      const customer = state.customers.find((item) => item.customer_id === cart.customer_id);
      const message = storeMessages.find((item) => item.cart_id === cart.cart_id);
      const conversion = storeConversions.find((item) => item.cart_id === cart.cart_id);

      return {
        cart_id: cart.cart_id,
        customer_name: customer?.first_name || "Unknown",
        cart_value: cart.cart_value,
        currency: cart.currency,
        abandoned_at: cart.abandoned_at || null,
        customer_phone: customer?.phone || "",
        whatsapp_consent: Boolean(customer?.whatsapp_consent),
        status: cart.status,
        message_status: message?.status || "none",
        recovered_revenue: conversion?.recovered_revenue || 0,
        checkout_url: cart.checkout_url
      };
    }),
    recovery_queue: storeCarts
      .filter((cart) => cart.status !== "purchased")
      .map((cart) => {
        const customer = state.customers.find((item) => item.customer_id === cart.customer_id);
        const message = storeMessages.find((item) => item.cart_id === cart.cart_id);
        const blockedActivity = latestActivityForCart(state, cart.cart_id, [
          "message_not_scheduled",
          "message_limit_reached",
          "message_cancelled",
          "message_failed"
        ]);
        const hasConsent = Boolean(customer?.whatsapp_consent);
        const actionReady = Boolean(message && ["ready_to_send", "manual_send_needed", "failed"].includes(message.status));
        const sendAttempts = Number(message?.send_attempts) || 0;
        const maxSendAttempts = 2;

        return {
          message_id: message?.message_id || null,
          customer_name: customer?.first_name || "Unknown",
          customer_phone: customer?.phone || "",
          whatsapp_consent: hasConsent,
          cart_id: cart.cart_id,
          cart_value: cart.cart_value || 0,
          currency: cart.currency || "USD",
          abandoned_at: cart.abandoned_at || null,
          status: message?.status || (hasConsent ? "no_message" : "not_scheduled"),
          provider: message?.provider || null,
          provider_status: message?.provider_status || null,
          provider_error_code: message?.provider_error_code || null,
          provider_status_checked_at: message?.provider_status_checked_at || null,
          scheduled_at: message?.scheduled_at || null,
          ready_at: message?.ready_at || null,
          checkout_url: cart.checkout_url || "",
          message_preview: message?.message_preview || (blockedActivity?.details?.reason || blockedActivity?.message || "No prepared message yet."),
          failure_reason: message?.failure_reason ? sanitizeProviderFailureReason(message.failure_reason) : null,
          last_failure_reason: message?.last_failure_reason ? sanitizeProviderFailureReason(message.last_failure_reason) : null,
          send_attempts: sendAttempts,
          max_send_attempts: maxSendAttempts,
          blocked_reason: blockedActivity
            ? sanitizeProviderFailureReason(blockedActivity.details?.reason || blockedActivity.message)
            : null,
          can_copy: Boolean(message?.message_preview),
          can_open_whatsapp: Boolean(actionReady && message?.message_preview && hasConsent),
          can_mark_sent: actionReady,
          can_mark_test_consent: Boolean(!hasConsent && customer?.phone && cart.status !== "purchased"),
          can_retry: Boolean(message?.status === "failed" && sendAttempts < maxSendAttempts),
          retry_blocked_reason: message?.status === "failed" && sendAttempts >= maxSendAttempts
            ? "Max send attempts reached"
            : null
        };
      }),
    messages: storeMessages.map((message) => {
      const customer = state.customers.find((item) => item.customer_id === message.customer_id);
      return {
        message_id: message.message_id,
        customer_name: customer?.first_name || "Unknown",
        customer_phone: customer?.phone || "",
        channel: message.channel,
        status: message.status,
        provider: message.provider || null,
        provider_status: message.provider_status || null,
        provider_error_code: message.provider_error_code || null,
        provider_status_checked_at: message.provider_status_checked_at || null,
        send_attempts: message.send_attempts || 0,
        scheduled_at: message.scheduled_at,
        sent_at: message.sent_at || null,
        manual_sent_at: message.manual_sent_at || null,
        message_preview: message.message_preview,
        failure_reason: message.failure_reason ? sanitizeProviderFailureReason(message.failure_reason) : null,
        last_failure_reason: message.last_failure_reason ? sanitizeProviderFailureReason(message.last_failure_reason) : null,
        fake_send_log: message.fake_send_log || null
      };
    }),
    conversions: storeConversions,
    audits: buildAuditRows(state, activeStoreId),
    activity: (state.activity || []).slice().reverse().map((item) => ({
      ...item,
      details: item.details?.reason
        ? {
            ...item.details,
            reason: sanitizeProviderFailureReason(item.details.reason)
          }
        : item.details
    }))
  };
}

module.exports = {
  buildDashboardSummary
};
