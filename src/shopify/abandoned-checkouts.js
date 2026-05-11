const SHOPIFY_ADMIN_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || "2026-04";

function customerFromCheckout(checkout) {
  const customer = checkout.customer || {};
  const billingAddress = checkout.billing_address || {};
  const shippingAddress = checkout.shipping_address || {};
  const firstName = customer.first_name || billingAddress.first_name || shippingAddress.first_name || "";
  const phone = checkout.phone || customer.phone || billingAddress.phone || shippingAddress.phone || "";
  const email = checkout.email || customer.email || "";

  return {
    customer_id: customer.id ? `shopify_customer_${customer.id}` : `checkout_customer_${checkout.token || checkout.id}`,
    first_name: firstName,
    phone,
    email,
    whatsapp_consent: Boolean(phone && checkout.buyer_accepts_marketing)
  };
}

function itemsFromCheckout(checkout) {
  return (checkout.line_items || []).map((item) => ({
    product_id: item.product_id ? String(item.product_id) : null,
    variant_id: item.variant_id ? String(item.variant_id) : null,
    product_name: item.title || item.name || "Item",
    variant_title: item.variant_title || null,
    quantity: Number(item.quantity) || 1,
    price: Number(item.price) || 0
  }));
}

function abandonedCheckoutToEvent(store, checkout) {
  const token = checkout.token || checkout.id;

  return {
    event_type: "abandoned_cart",
    event_id: `shopify_abandoned_checkout_${store.store_id}_${token}`,
    store: {
      store_id: store.store_id,
      store_name: store.store_name || store.store_domain.replace(".myshopify.com", ""),
      store_domain: store.store_domain
    },
    customer: customerFromCheckout(checkout),
    cart: {
      cart_id: `shopify_checkout_${token}`,
      checkout_token: checkout.token || null,
      cart_token: checkout.cart_token || null,
      checkout_url: checkout.abandoned_checkout_url || checkout.web_url || "",
      currency: checkout.presentment_currency || checkout.currency || "USD",
      cart_value: Number(checkout.total_price || checkout.subtotal_price || 0),
      items: itemsFromCheckout(checkout),
      abandoned_at: checkout.created_at || checkout.updated_at || new Date().toISOString(),
      status: "abandoned"
    },
    source: {
      platform: "shopify",
      type: "abandoned_checkout_import",
      checkout_id: checkout.id || null,
      checkout_token: checkout.token || null
    }
  };
}

async function fetchAbandonedCheckouts(store, limit = 10) {
  const url = new URL(`https://${store.store_domain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/checkouts.json`);
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Shopify-Access-Token": store.shopify_access_token
    }
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.errors || payload.error || "Shopify abandoned checkouts request failed");
  }

  return payload.checkouts || [];
}

module.exports = {
  abandonedCheckoutToEvent,
  fetchAbandonedCheckouts
};
