const SHOPIFY_ADMIN_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || "2026-04";

async function fetchOrders(store, limit = 10) {
  const url = new URL(`https://${store.store_domain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/orders.json`);
  url.searchParams.set("status", "any");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set(
    "fields",
    [
      "id",
      "admin_graphql_api_id",
      "name",
      "order_number",
      "currency",
      "presentment_currency",
      "total_price",
      "current_total_price",
      "checkout_token",
      "cart_token",
      "created_at",
      "processed_at",
      "customer",
      "email",
      "phone"
    ].join(",")
  );

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Shopify-Access-Token": store.shopify_access_token
    }
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.errors || payload.error || "Shopify orders request failed");
  }

  return payload.orders || [];
}

module.exports = {
  fetchOrders
};
