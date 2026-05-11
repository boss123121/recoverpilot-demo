const { buildPilotPackage } = require("./pilot-package");

function check(id, label, status, detail, nextStep = "") {
  return {
    id,
    label,
    status,
    detail,
    next_step: nextStep
  };
}

function readFlag(flags, key) {
  return flags?.[key] === true || flags?.[key] === "true";
}

function isTemporaryAppUrl(appUrl) {
  const normalized = String(appUrl || "").toLowerCase();
  return normalized.includes("localhost") ||
    normalized.includes("127.0.0.1") ||
    normalized.includes(".ngrok") ||
    normalized.includes("ngrok-free.app");
}

function countStoreRows(state, storeId) {
  const carts = (state.carts || []).filter((item) => item.store_id === storeId);
  const messages = (state.messages || []).filter((item) => item.store_id === storeId);
  const conversions = (state.conversions || []).filter((item) => item.store_id === storeId);
  const recoveredRevenue = conversions.reduce((total, conversion) => {
    return total + Number(conversion.recovered_revenue || 0);
  }, 0);

  return {
    abandoned_carts: carts.length,
    open_carts: carts.filter((item) => item.status !== "purchased").length,
    messages_sent: messages.filter((item) => {
      return ["manual_sent", "sent", "fake_sent"].includes(item.status);
    }).length,
    failed_or_blocked: messages.filter((item) => {
      return ["failed", "cancelled", "not_scheduled"].includes(item.status);
    }).length,
    conversions: conversions.length,
    recovered_revenue: recoveredRevenue
  };
}

function buildSummary(checks) {
  const blocked = checks.filter((item) => item.status === "blocked");
  const actionNeeded = checks.filter((item) => item.status === "action_needed");
  const ready = checks.filter((item) => item.status === "ready");
  const status = blocked.length > 0
    ? "blocked"
    : actionNeeded.length > 0
      ? "action_needed"
      : "ready";

  return {
    status,
    ready: ready.length,
    total: checks.length,
    blocked: blocked.length,
    action_needed: actionNeeded.length,
    label: status === "ready"
      ? "Ready to start one controlled client pilot"
      : status === "action_needed"
        ? "Almost ready, but finish the pilot action items first"
        : "Blocked before an outside client pilot"
  };
}

function buildClientPilotPlan(state, options = {}) {
  state.stores ||= [];
  state.carts ||= [];
  state.messages ||= [];
  state.conversions ||= [];

  const packagePlan = buildPilotPackage(state);
  const activeStore = packagePlan.active_store;
  const storeId = activeStore?.store_id || "";
  const proofReady = Boolean(
    packagePlan.proof_story &&
    Number(packagePlan.proof_story.recovered_revenue || 0) > 0
  );
  const pilotPackageReady = packagePlan.status === "ready";
  const manualPilotMode = Boolean(options.manualPilotMode);
  const appUrl = options.shopifyConfig?.appUrl || "";
  const hasHttpsAppUrl = Boolean(appUrl && appUrl.startsWith("https://"));
  const temporaryAppUrl = isTemporaryAppUrl(appUrl);
  const productionFlags = options.productionFlags || {};
  const merchantAccessReady = readFlag(productionFlags, "merchantAuthReady");
  const privacyReady = readFlag(productionFlags, "privacyReady");
  const billingReady = readFlag(productionFlags, "billingReady");
  const deploymentReady = readFlag(productionFlags, "deploymentReady") && hasHttpsAppUrl && !temporaryAppUrl;

  const checks = [
    check(
      "one_store_only",
      "One-store pilot rule",
      "ready",
      "Phase 20 should test one real fashion/lifestyle Shopify store before onboarding more merchants.",
      ""
    ),
    check(
      "shopify_store_available",
      "Shopify store connection exists",
      activeStore?.app_status === "installed" && activeStore.has_shopify_access_token ? "ready" : "blocked",
      activeStore
        ? `${activeStore.store_domain} is ${activeStore.app_status}; access token saved: ${activeStore.has_shopify_access_token ? "yes" : "no"}.`
        : "No installed Shopify store is saved locally.",
      "Install RecoverPilot on the pilot store or refresh the current Shopify install."
    ),
    check(
      "internal_recovered_sale_proof",
      "Internal recovered-sale proof",
      proofReady ? "ready" : "action_needed",
      proofReady
        ? packagePlan.proof_story.summary
        : "No credited recovered sale proof exists for the active store yet.",
      "Before asking a merchant to trust the pilot, keep one internal recovered-sale proof ready."
    ),
    check(
      "pilot_package",
      "Pilot package",
      pilotPackageReady ? "ready" : "action_needed",
      pilotPackageReady
        ? "Offer, qualification questions, checklist, demo script, and message examples are ready."
        : "The pilot package exists, but it still needs proof before being cleanly ready.",
      "Use /pilot/package and docs/phase-19-first-pilot-package.md to prepare the partner script."
    ),
    check(
      "manual_review_mode",
      "Manual Review Mode",
      manualPilotMode ? "ready" : "action_needed",
      manualPilotMode
        ? "Manual Review Mode is enabled, so the merchant/operator can review before sending."
        : "Manual Review Mode is not enabled in the current runtime.",
      "For the first outside merchant, use MANUAL_PILOT_MODE=true unless WhatsApp production templates are fully approved."
    ),
    check(
      "public_callback",
      "Public callback URL",
      hasHttpsAppUrl ? "ready" : "blocked",
      hasHttpsAppUrl
        ? `Shopify app URL is HTTPS: ${appUrl}.`
        : `Shopify app URL is not public HTTPS: ${appUrl || "missing"}.`,
      "Use a live ngrok URL for a controlled pilot or deploy a stable HTTPS app before installing on the pilot store."
    ),
    check(
      "merchant_dashboard_access",
      "Merchant dashboard access",
      merchantAccessReady ? "ready" : "action_needed",
      merchantAccessReady
        ? "Merchant access protection is marked ready."
        : "The local dashboard is still founder/operator controlled. Do not give open dashboard access to a merchant yet.",
      "For the first pilot, you can operate RecoverPilot yourself. Before merchant self-serve access, add Shopify-session-protected access."
    ),
    check(
      "privacy_and_consent_notes",
      "Privacy and consent notes",
      privacyReady ? "ready" : "action_needed",
      privacyReady
        ? "Privacy and consent notes are marked ready."
        : "The first client still needs a plain explanation of phone use, consent expectation, opt-out, and data retention.",
      "Prepare a simple pilot agreement or consent note before touching real customer phone numbers."
    ),
    check(
      "pilot_agreement",
      "Pilot agreement or written scope",
      billingReady ? "ready" : "action_needed",
      billingReady
        ? "Billing or pilot agreement is marked ready."
        : "A paid billing system is not required, but the merchant should agree to the 7-14 day pilot scope in writing.",
      "Use a short written pilot scope: one store, WhatsApp cart recovery, manual review first, honest attribution."
    ),
    check(
      "broad_launch_blockers",
      "Broad public launch blockers",
      deploymentReady && merchantAccessReady && privacyReady ? "ready" : "action_needed",
      deploymentReady && merchantAccessReady && privacyReady
        ? "Deployment, merchant access, and privacy gates are marked ready."
        : "Still not a public launch. This is only safe as a controlled one-store pilot.",
      "Finish stable deployment, merchant auth, privacy/compliance, and production WhatsApp templates before scaling."
    )
  ];

  const summary = buildSummary(checks);

  return {
    ok: true,
    phase: "20-first-client-pilot",
    status: summary.status,
    recommended_mode: "manual_review",
    pilot_length_days: 14,
    active_store: activeStore,
    internal_proof: {
      ready: proofReady,
      story: packagePlan.proof_story,
      metrics: packagePlan.proof_metrics
    },
    store_counts: storeId ? countStoreRows(state, storeId) : null,
    readiness: {
      summary,
      checks
    },
    roles: {
      founder: [
        "Install or refresh RecoverPilot on the pilot Shopify store.",
        "Check Shopify imports, webhooks, message status, and attribution every day.",
        "Fix data, consent, provider, and dashboard issues during the pilot.",
        "Capture screenshots of recovered revenue and Decision Audit proof."
      ],
      partner: [
        "Find and qualify one fashion/lifestyle Shopify store.",
        "Explain the 14-day pilot in plain business language.",
        "Collect merchant objections, feedback, and yes/no decision at the end.",
        "Keep the merchant focused on recovered revenue and learning, not feature requests."
      ],
      merchant: [
        "Allow RecoverPilot to connect to Shopify for the pilot.",
        "Confirm customer-contact and consent expectations.",
        "Review or send WhatsApp follow-ups during the pilot.",
        "Share replies, objections, and whether recovered revenue is meaningful."
      ]
    },
    onboarding_sequence: [
      "Choose one fashion/lifestyle Shopify store.",
      "Confirm the store has checkout traffic and customer phone numbers.",
      "Agree on a 7-14 day pilot scope in writing.",
      "Install RecoverPilot and confirm Shopify scopes.",
      "Register webhooks and import abandoned checkouts.",
      "Set Manual Review Mode, delay, attribution window, and first message template.",
      "Run one test checkout before contacting real customers.",
      "Operate the Recovery Queue daily.",
      "Import orders if webhooks miss anything.",
      "Review recovered revenue, Decision Audit, replies, and merchant feedback."
    ],
    daily_routine: [
      "Open RecoverPilot once or twice per day.",
      "Review Recovery Queue and prioritize carts with phone, consent, and higher value.",
      "Open WhatsApp or copy the prepared message.",
      "Mark message as sent only after it was actually sent.",
      "Check failed, blocked, and no-consent carts.",
      "Import orders if needed and verify conversions.",
      "Record replies and objection tags.",
      "Send a short daily summary to the merchant."
    ],
    tracking_sheet_columns: [
      "Date",
      "Carts captured",
      "Messages sent",
      "Blocked/no consent",
      "Failed messages",
      "Replies",
      "Main objections",
      "Orders after message",
      "Recovered revenue",
      "Attribution reason",
      "Merchant feedback",
      "Next action"
    ],
    success_criteria: [
      "At least one honestly credited recovered sale.",
      "Merchant understands what RecoverPilot did and wants to continue testing or paying.",
      "RecoverPilot identifies a clear blocker worth fixing, such as no phone capture, consent gaps, or weak checkout traffic."
    ],
    stop_or_pause_criteria: [
      "Store has no abandoned checkouts during the pilot.",
      "Customers do not provide phone numbers.",
      "Consent is unclear and merchant cannot confirm a safe contact basis.",
      "Merchant does not check or support the recovery flow.",
      "WhatsApp provider/template rules block sending and manual fallback is not acceptable."
    ],
    do_not_build_during_pilot: [
      "Multi-store onboarding",
      "Full Recovery Score engine",
      "Full Message Angle Engine",
      "Partner Reward Layer",
      "Email/SMS channels",
      "Complex analytics",
      "Public app launch flow"
    ]
  };
}

module.exports = {
  buildClientPilotPlan
};
