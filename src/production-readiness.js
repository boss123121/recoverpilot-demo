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

function hasWebhookRegistrationActivity(state, storeId) {
  return state.activity.some((activity) => {
    return activity.type === "shopify_webhook_registration_completed" &&
      activity.details?.store_id === storeId;
  });
}

function hasDeliveryProof(state, storeId) {
  return state.messages.some((message) => {
    return message.store_id === storeId && ["manual_sent", "sent", "fake_sent"].includes(message.status);
  });
}

function hasRecoveredRevenueProof(state, storeId) {
  return state.conversions.some((conversion) => {
    return conversion.store_id === storeId &&
      conversion.recovered_by_message &&
      Number(conversion.recovered_revenue || 0) > 0;
  });
}

function isTemporaryAppUrl(appUrl) {
  const normalized = String(appUrl || "").toLowerCase();
  return normalized.includes("localhost") ||
    normalized.includes("127.0.0.1") ||
    normalized.includes(".ngrok") ||
    normalized.includes("ngrok-free.app");
}

function buildSummary(checks, labels) {
  const blockers = checks.filter((item) => item.status === "blocked");
  const actionNeeded = checks.filter((item) => item.status === "action_needed");
  const readyCount = checks.filter((item) => item.status === "ready").length;
  const status = blockers.length > 0
    ? "blocked"
    : actionNeeded.length > 0
      ? "action_needed"
      : "ready";

  return {
    status,
    ready: readyCount,
    total: checks.length,
    blocked: blockers.length,
    action_needed: actionNeeded.length,
    label: labels[status]
  };
}

function readFlag(flags, key) {
  return flags?.[key] === true || flags?.[key] === "true";
}

function buildProductionReadiness(state, options = {}) {
  state.stores ||= [];
  state.campaign_settings ||= [];
  state.messages ||= [];
  state.conversions ||= [];
  state.activity ||= [];

  const activeStore = selectActiveStore(state);
  const store = safeStore(activeStore);
  const storeId = activeStore?.store_id || "";
  const settings = findStoreSettings(state, activeStore);
  const scopes = store?.shopify_scopes || [];
  const shopifyConfig = options.shopifyConfig || {};
  const appUrl = shopifyConfig.appUrl || "";
  const hasHttpsAppUrl = Boolean(appUrl && appUrl.startsWith("https://"));
  const campaignReady = Boolean(
    activeStore &&
    settings &&
    settings.enabled &&
    Number(settings.delay_minutes) >= 0 &&
    Number(settings.attribution_window_days || 0) >= 1 &&
    hasTemplateCheckoutLink(settings.message_template)
  );
  const twilioConfigured = Boolean(options.twilioValidation?.ok);
  const twilioEnabled = Boolean(options.twilioConfig?.enabled);
  const manualMode = Boolean(options.manualPilotMode);
  const deliveryPathReady = Boolean(manualMode || (twilioEnabled && twilioConfigured));
  const deliveryProofReady = Boolean(storeId && hasDeliveryProof(state, storeId));
  const recoveredRevenueProofReady = Boolean(storeId && hasRecoveredRevenueProof(state, storeId));
  const temporaryAppUrl = isTemporaryAppUrl(appUrl);
  const flags = options.productionFlags || {};

  const selfTrialChecks = [
    check(
      "shopify_install",
      "Shopify dev store connected",
      store?.app_status === "installed" && store.has_shopify_access_token ? "ready" : "blocked",
      store
        ? `${store.store_domain} is ${store.app_status}; access token saved: ${store.has_shopify_access_token ? "yes" : "no"}.`
        : "No Shopify store is installed locally yet.",
      "Install RecoverPilot into your own Shopify development store."
    ),
    check(
      "shopify_scopes",
      "Shopify data scopes",
      scopes.includes("read_orders") && scopes.includes("read_customers") ? "ready" : "blocked",
      scopes.length ? `Saved scopes: ${scopes.join(", ")}.` : "No Shopify scopes saved for the active store.",
      "Use read_orders and read_customers, create a new app version, then reinstall."
    ),
    check(
      "public_callback",
      "Public callback URL",
      hasHttpsAppUrl ? "ready" : "blocked",
      hasHttpsAppUrl
        ? `Current callback host is public HTTPS: ${appUrl}.`
        : `Current app URL is not public HTTPS: ${appUrl || "missing"}.`,
      "Run ngrok or deploy the app, then set SHOPIFY_APP_URL to the HTTPS URL."
    ),
    check(
      "webhook_path",
      "Webhook path tested",
      storeId && hasWebhookRegistrationActivity(state, storeId) ? "ready" : "action_needed",
      storeId && hasWebhookRegistrationActivity(state, storeId)
        ? "RecoverPilot recorded a successful webhook registration for this store."
        : "Webhook registration has not been recorded for this store in local state.",
      "Register webhooks and create one Shopify order to prove the order webhook path."
    ),
    check(
      "campaign_rules",
      "Campaign rules",
      campaignReady ? "ready" : "blocked",
      campaignReady
        ? `Campaign on, ${settings.delay_minutes} min delay, ${settings.attribution_window_days} day attribution.`
        : "Campaign is missing, off, or the template does not include {{checkout_url}}.",
      "Turn campaign on and keep {{checkout_url}} in the WhatsApp template."
    ),
    check(
      "whatsapp_delivery",
      "WhatsApp delivery mode",
      deliveryPathReady ? "ready" : "blocked",
      manualMode
        ? "Manual sending is on. This is acceptable for your self-trial."
        : twilioEnabled && twilioConfigured
          ? "Twilio WhatsApp sending is enabled and configured."
          : "No manual or provider WhatsApp path is ready.",
      "Use manual mode for self-trial or finish Twilio sandbox setup."
    ),
    check(
      "delivery_proof",
      "Message proof",
      deliveryProofReady ? "ready" : "action_needed",
      deliveryProofReady
        ? "At least one recovery message has been marked/sent for this store."
        : "No recovery message proof is recorded for this store yet.",
      "Run one abandoned cart through the queue and mark/send the message."
    ),
    check(
      "recovered_revenue_proof",
      "Recovered revenue proof",
      recoveredRevenueProofReady ? "ready" : "action_needed",
      recoveredRevenueProofReady
        ? "At least one order was honestly credited as recovered revenue."
        : "No credited recovered order is recorded for this store yet.",
      "Complete one matching Shopify order after a recovery message and confirm attribution."
    )
  ];

  const publicLaunchChecks = [
    check(
      "permanent_deployment",
      "Permanent app deployment",
      readFlag(flags, "deploymentReady") && hasHttpsAppUrl && !temporaryAppUrl ? "ready" : "blocked",
      temporaryAppUrl
        ? "Current app URL is a local tunnel or localhost. Good for self-trial, not public launch."
        : hasHttpsAppUrl
          ? "App URL is public HTTPS, but production deployment has not been confirmed."
          : "No public HTTPS deployment is configured.",
      "Deploy RecoverPilot to a stable host and update Shopify app URLs away from ngrok."
    ),
    check(
      "merchant_access",
      "Merchant access protection",
      readFlag(flags, "merchantAuthReady") ? "ready" : "blocked",
      "The local dashboard is not enough for outside merchants. Production needs Shopify-session-protected access.",
      "Add proper Shopify embedded app/session protection before onboarding outside stores."
    ),
    check(
      "production_whatsapp",
      "Production WhatsApp approval",
      readFlag(flags, "whatsappApproved") ? "ready" : "action_needed",
      twilioEnabled && twilioConfigured
        ? "Twilio sandbox/config exists, but production sender/template approval is not confirmed."
        : "WhatsApp production sender, templates, and opt-out handling are not confirmed.",
      "Get a production WhatsApp sender/template path before auto-sending for outside merchants."
    ),
    check(
      "database_backups",
      "Production database and backups",
      readFlag(flags, "databaseReady") ? "ready" : "blocked",
      "Local SQLite is okay for self-trial. Public launch needs hosted storage, backups, and migration discipline.",
      "Move runtime data to a production database with backups before public launch."
    ),
    check(
      "privacy_compliance",
      "Privacy and compliance docs",
      readFlag(flags, "privacyReady") ? "ready" : "blocked",
      "Customer phone/order data requires clear privacy, uninstall, retention, and consent handling notes.",
      "Prepare privacy policy, data handling notes, and merchant consent expectations."
    ),
    check(
      "webhook_hygiene",
      "Webhook hygiene",
      readFlag(flags, "webhookHygieneConfirmed") ? "ready" : "action_needed",
      "Old ngrok webhook URLs can remain in Shopify during development. They should be cleaned before launch.",
      "List Shopify webhooks and remove old tunnel URLs after the final deployment URL exists."
    ),
    check(
      "billing",
      "Billing or pilot agreement",
      readFlag(flags, "billingReady") ? "ready" : "action_needed",
      "Billing is not required for your self-trial, but a real client needs either a pilot agreement or billing path.",
      "Create a simple 14-day pilot agreement before the first outside merchant."
    )
  ];

  const selfTrialSummary = buildSummary(selfTrialChecks, {
    ready: "Self-trial proof complete",
    action_needed: "Ready to self-trial; proof still needed",
    blocked: "Self-trial blocked"
  });
  const publicLaunchSummary = buildSummary(publicLaunchChecks, {
    ready: "Public launch ready",
    action_needed: "Public launch needs cleanup",
    blocked: "Public launch not ready"
  });

  return {
    ok: true,
    phase: "18-production-self-trial",
    mode: "self_trial_before_external_client",
    active_store: store,
    self_trial: {
      status: selfTrialSummary.status,
      summary: selfTrialSummary,
      checks: selfTrialChecks
    },
    public_launch: {
      status: publicLaunchSummary.status,
      summary: publicLaunchSummary,
      checks: publicLaunchChecks
    },
    recommendation: publicLaunchSummary.status === "ready"
      ? "Public launch gates are clear. You can move toward outside merchants."
      : selfTrialSummary.status === "blocked"
        ? "Do not chase full production yet. Unblock the self-trial path first."
        : "Use your own dev store as the first client, prove one recovered sale, then close the public-launch blockers.",
    next_steps: [
      ...selfTrialChecks.filter((item) => item.status !== "ready" && item.next_step),
      ...publicLaunchChecks.filter((item) => item.status !== "ready" && item.next_step)
    ].slice(0, 5).map((item) => item.next_step)
  };
}

module.exports = {
  buildProductionReadiness
};
