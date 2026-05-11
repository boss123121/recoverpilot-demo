function splitScopes(scopeString) {
  return String(scopeString || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeStore(store) {
  if (!store) return null;

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

function latestByCreatedAt(items) {
  return items.slice().sort((a, b) => {
    return new Date(b.created_at || b.purchased_at || 0) - new Date(a.created_at || a.purchased_at || 0);
  })[0] || null;
}

function buildProofStory(state, activeStore) {
  if (!activeStore) {
    return null;
  }

  const recoveredConversion = latestByCreatedAt(
    state.conversions.filter((conversion) => {
      return conversion.store_id === activeStore.store_id &&
        conversion.recovered_by_message &&
        Number(conversion.recovered_revenue || 0) > 0;
    })
  );

  if (!recoveredConversion) {
    return null;
  }

  const cart = state.carts.find((item) => item.cart_id === recoveredConversion.cart_id);
  const message = state.messages.find((item) => item.message_id === recoveredConversion.message_id);
  const customer = cart
    ? state.customers.find((item) => item.customer_id === cart.customer_id)
    : null;

  return {
    summary: `${customer?.first_name || "A shopper"} abandoned a ${recoveredConversion.currency || "USD"} ${Number(cart?.cart_value || recoveredConversion.recovered_revenue || 0).toFixed(2)} cart, received a recovery follow-up, then purchased within the attribution window.`,
    store_domain: activeStore.store_domain,
    customer_name: customer?.first_name || "Customer",
    cart_id: recoveredConversion.cart_id,
    order_id: recoveredConversion.order_id,
    message_id: recoveredConversion.message_id,
    message_status: message?.status || "unknown",
    recovered_revenue: Number(recoveredConversion.recovered_revenue || 0),
    currency: recoveredConversion.currency || cart?.currency || "USD",
    attribution_reason: recoveredConversion.attribution_reason,
    message_sent_at: recoveredConversion.message_sent_at,
    purchased_at: recoveredConversion.purchased_at
  };
}

function buildPilotPackage(state) {
  state.stores ||= [];
  state.carts ||= [];
  state.messages ||= [];
  state.conversions ||= [];
  state.customers ||= [];

  const activeStore = selectActiveStore(state);
  const store = safeStore(activeStore);
  const proofStory = buildProofStory(state, activeStore);
  const storeId = activeStore?.store_id || "";
  const storeConversions = state.conversions.filter((conversion) => conversion.store_id === storeId);
  const recoveredRevenue = storeConversions.reduce((total, conversion) => {
    return total + Number(conversion.recovered_revenue || 0);
  }, 0);

  const checks = [
    {
      id: "self_trial_proof",
      label: "Self-trial recovered sale proof",
      status: proofStory ? "ready" : "action_needed",
      detail: proofStory
        ? `Recovered ${proofStory.currency} ${proofStory.recovered_revenue.toFixed(2)} on ${store?.store_domain}.`
        : "No credited recovered sale exists for the active store yet."
    },
    {
      id: "pilot_offer",
      label: "Pilot offer",
      status: "ready",
      detail: "14-day WhatsApp abandoned-cart recovery pilot for fashion Shopify stores."
    },
    {
      id: "merchant_requirements",
      label: "Merchant requirements",
      status: "ready",
      detail: "Shopify store, checkout traffic, phone capture, consent expectation, and willingness to review messages."
    },
    {
      id: "demo_script",
      label: "Partner demo script",
      status: "ready",
      detail: "Explain abandoned cart, prepared WhatsApp message, manual review, mark sent, purchase, and recovered revenue proof."
    }
  ];

  return {
    ok: true,
    phase: "19-first-pilot-package",
    status: checks.every((item) => item.status === "ready") ? "ready" : "action_needed",
    active_store: store,
    proof_story: proofStory,
    proof_metrics: {
      abandoned_carts: state.carts.filter((cart) => cart.store_id === storeId).length,
      messages: state.messages.filter((message) => message.store_id === storeId).length,
      conversions: storeConversions.length,
      recovered_revenue: recoveredRevenue,
      currency: proofStory?.currency || storeConversions[0]?.currency || "USD"
    },
    checks,
    offer: {
      name: "14-day WhatsApp abandoned-cart recovery pilot",
      plain_pitch: "RecoverPilot helps fashion Shopify stores follow up on abandoned carts through safe WhatsApp review and proves whether the follow-up recovered revenue.",
      promise: "We will help you find abandoned carts, prepare recovery messages, and track recovered revenue honestly.",
      non_promise: "We do not promise every cart will recover, and we do not blast customers without consent."
    },
    partner_script: [
      "We are testing RecoverPilot with a small number of fashion Shopify stores.",
      "It watches abandoned checkouts and creates a WhatsApp recovery queue.",
      "You can review each message before sending, so it is safer than full automation.",
      "The key number is recovered revenue, not vanity message counts.",
      "If the store does not recover anything or the data is weak, we learn that quickly."
    ],
    qualification_questions: [
      "Are you using Shopify?",
      "Do customers usually enter a phone number at checkout?",
      "Do you get abandoned carts or started checkouts every week?",
      "Are you comfortable reviewing WhatsApp follow-ups manually for the first pilot?",
      "Do you have a clear consent or customer-contact expectation?",
      "What is your average order value?",
      "What products cause the most hesitation: dresses, jeans, sizes, delivery timing, price, or trust?"
    ],
    merchant_setup_checklist: [
      "Install RecoverPilot on the Shopify store.",
      "Confirm Shopify scopes and abandoned checkout import.",
      "Confirm order webhook or order import backup.",
      "Choose Manual Review Mode for the first pilot.",
      "Set delay and attribution window.",
      "Approve the first WhatsApp message template/tone.",
      "Run one test checkout before touching live customers.",
      "Check Recovery Queue daily for 7 to 14 days."
    ],
    message_examples: [
      {
        angle: "general reminder",
        use_when: "Cart is fresh and low risk.",
        message: "Hi {{first_name}}, you left something in your cart. You can complete your order here: {{checkout_url}}"
      },
      {
        angle: "size reassurance",
        use_when: "Dress, jeans, shoes, or size-based item.",
        message: "Hi {{first_name}}, still thinking about the size? Reply here if you want help choosing before completing your order: {{checkout_url}}"
      },
      {
        angle: "return/exchange reassurance",
        use_when: "Customer may worry about fit or buying from a new store.",
        message: "Hi {{first_name}}, your cart is still saved. If you are unsure about fit or exchange options, we can help before you order: {{checkout_url}}"
      },
      {
        angle: "delivery timing",
        use_when: "Eventwear or time-sensitive purchase.",
        message: "Hi {{first_name}}, your cart is saved. If you need it by a certain date, reply and we can check delivery timing: {{checkout_url}}"
      }
    ],
    daily_pilot_routine: [
      "Open RecoverPilot once or twice per day.",
      "Review carts that need follow-up.",
      "Open WhatsApp or copy the prepared message.",
      "Mark the message as sent.",
      "Import orders if webhooks were missed.",
      "Check recovered revenue and Decision Audit.",
      "Write down customer replies and objections."
    ]
  };
}

module.exports = {
  buildPilotPackage
};
