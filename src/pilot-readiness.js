function splitScopes(scopeString) {
  return String(scopeString || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeStore(store) {
  if (!store) {
    return null;
  }

  return {
    store_id: store.store_id,
    store_name: store.store_name || store.store_domain || "Unknown store",
    store_domain: store.store_domain || "",
    app_status: store.app_status || "unknown",
    has_shopify_access_token: Boolean(store.shopify_access_token),
    shopify_scopes: splitScopes(store.shopify_scope),
    updated_at: store.updated_at || null
  };
}

function selectActiveStore(state) {
  return state.stores.find((store) => {
    return store.app_status === "installed" && store.shopify_access_token;
  }) || state.stores.find((store) => store.store_domain) || null;
}

function findStoreSettings(state, store) {
  if (!store) {
    return null;
  }

  return state.campaign_settings.find((settings) => settings.store_id === store.store_id) || null;
}

function check(id, label, status, detail, nextStep = "") {
  return {
    id,
    label,
    status,
    detail,
    next_step: nextStep
  };
}

function hasTemplateCheckoutLink(template) {
  return String(template || "").includes("{{checkout_url}}");
}

function hasAnyPilotProof(state, storeId) {
  return state.messages.some((message) => {
    return message.store_id === storeId && ["manual_sent", "sent", "fake_sent"].includes(message.status);
  }) || state.conversions.some((conversion) => conversion.store_id === storeId);
}

function buildPilotReadiness(state, options) {
  state.stores ||= [];
  state.campaign_settings ||= [];
  state.messages ||= [];
  state.conversions ||= [];
  state.activity ||= [];

  const activeStore = selectActiveStore(state);
  const store = safeStore(activeStore);
  const settings = findStoreSettings(state, activeStore);
  const scopes = store?.shopify_scopes || [];
  const shopifyAppUrl = options.shopifyConfig?.appUrl || "";
  const shopifyWebhookHttpsReady = Boolean(shopifyAppUrl && shopifyAppUrl.startsWith("https://"));
  const shopifyConfigReady = Boolean(options.shopifyConfigCheck?.ok);
  const twilioReady = Boolean(
    options.twilioConfig?.enabled &&
    options.twilioValidation?.ok &&
    options.twilioConfig?.testTo
  );
  const whatsappDeliveryReady = Boolean(options.manualPilotMode || twilioReady);
  const campaignReady = Boolean(
    activeStore &&
    settings &&
    settings.enabled &&
    Number(settings.delay_minutes) >= 0 &&
    Number(settings.attribution_window_days || 0) >= 1 &&
    hasTemplateCheckoutLink(settings.message_template)
  );
  const webhookActivityReady = Boolean(activeStore && state.activity.some((activity) => {
    return activity.type === "shopify_webhook_registration_completed" &&
      activity.details?.store_id === activeStore.store_id;
  }));
  const pilotProofReady = Boolean(activeStore && hasAnyPilotProof(state, activeStore.store_id));

  const checks = [
    check(
      "shopify_config",
      "Shopify app config",
      shopifyConfigReady ? "ready" : "blocked",
      shopifyConfigReady
        ? "Shopify API key, secret, scopes, and app URL are present."
        : `Missing Shopify config: ${(options.shopifyConfigCheck?.missing || []).join(", ") || "unknown"}`,
      "Fill missing Shopify values in .env, then restart the app."
    ),
    check(
      "shopify_store",
      "Shopify store connected",
      store?.app_status === "installed" && store.has_shopify_access_token ? "ready" : "blocked",
      store
        ? `${store.store_domain} is ${store.app_status}; access token saved: ${store.has_shopify_access_token ? "yes" : "no"}.`
        : "No Shopify store is saved locally yet.",
      "Install or reinstall the RecoverPilot app from the Shopify dev dashboard."
    ),
    check(
      "shopify_scopes",
      "Required Shopify scopes",
      scopes.includes("read_orders") && scopes.includes("read_customers") ? "ready" : "blocked",
      scopes.length ? `Saved scopes: ${scopes.join(", ")}.` : "No Shopify scopes saved for the active store.",
      "Use read_orders and read_customers, then reinstall the app so Shopify grants them."
    ),
    check(
      "public_app_url",
      "Public HTTPS app URL",
      shopifyWebhookHttpsReady ? "ready" : "action_needed",
      shopifyWebhookHttpsReady
        ? `Webhook URL uses HTTPS: ${shopifyAppUrl}.`
        : `Current app URL is not public HTTPS: ${shopifyAppUrl || "missing"}.`,
      "Run ngrok, set SHOPIFY_APP_URL to the HTTPS tunnel, restart the app, then refresh Shopify app settings."
    ),
    check(
      "webhooks",
      "Webhook registration",
      webhookActivityReady ? "ready" : "action_needed",
      webhookActivityReady
        ? "RecoverPilot recorded a successful webhook registration for this store."
        : "Webhook registration has not been recorded for this store yet.",
      "Press Register Webhooks in Launch Setup after the HTTPS app URL is active."
    ),
    check(
      "campaign",
      "Campaign rules",
      campaignReady ? "ready" : "blocked",
      campaignReady
        ? `Campaign on, ${settings.delay_minutes} min delay, ${settings.attribution_window_days} day attribution.`
        : "Campaign settings are missing, off, or the message template lacks {{checkout_url}}.",
      "Turn campaign on, set delay/attribution, and keep {{checkout_url}} in the template."
    ),
    check(
      "whatsapp_delivery",
      "WhatsApp delivery path",
      whatsappDeliveryReady ? "ready" : "blocked",
      options.manualPilotMode
        ? "Manual pilot mode is on. Operator can open WhatsApp and mark sent."
        : twilioReady
          ? "Twilio WhatsApp is enabled and configured."
          : "No manual or provider sending path is ready.",
      "Use MANUAL_PILOT_MODE=true for free manual pilot, or finish Twilio setup."
    ),
    check(
      "safety_rules",
      "Safety rules",
      "ready",
      "Duplicate protection, purchase checks, webhook HMAC checks, failure reasons, retry limit, and token hiding are implemented.",
      ""
    ),
    check(
      "pilot_proof",
      "Internal proof run",
      pilotProofReady ? "ready" : "action_needed",
      pilotProofReady
        ? "There is at least one sent message or conversion for this store."
        : "No sent message or conversion is recorded for this store yet.",
      "Run one full internal flow before bringing in a merchant."
    )
  ];

  const blockers = checks.filter((item) => item.status === "blocked");
  const actionNeeded = checks.filter((item) => item.status === "action_needed");
  const readyCount = checks.filter((item) => item.status === "ready").length;
  const status = blockers.length > 0
    ? "blocked"
    : actionNeeded.length > 0
      ? "action_needed"
      : "ready";

  return {
    ok: true,
    phase: "17",
    status,
    active_store: store,
    summary: {
      ready: readyCount,
      total: checks.length,
      blocked: blockers.length,
      action_needed: actionNeeded.length,
      label: status === "ready"
        ? "Ready for first-client onboarding"
        : status === "action_needed"
          ? "Almost ready; finish the action items"
          : "Blocked before first-client onboarding"
    },
    checks,
    next_steps: checks
      .filter((item) => item.status !== "ready" && item.next_step)
      .slice(0, 4)
      .map((item) => item.next_step),
    onboarding_flow: [
      "Connect or refresh the Shopify store install.",
      "Confirm consent expectations with the merchant.",
      "Set delay, attribution window, and message template.",
      "Register webhooks and import abandoned checkouts.",
      "Run one full internal recovery test.",
      "Watch Activity Log and Decision Audit during the first live pilot."
    ]
  };
}

module.exports = {
  buildPilotReadiness
};
