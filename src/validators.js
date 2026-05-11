function validateAbandonedCartEvent(event) {
  const errors = [];

  if (!event || typeof event !== "object") errors.push("Event must be an object");
  if (event?.event_type !== "abandoned_cart") errors.push("event_type must be abandoned_cart");
  if (!event?.event_id) errors.push("event_id is required");
  if (!event?.store?.store_id) errors.push("store.store_id is required");
  if (!event?.store?.store_name) errors.push("store.store_name is required");
  if (!event?.customer?.customer_id) errors.push("customer.customer_id is required");
  if (!event?.cart?.cart_id) errors.push("cart.cart_id is required");
  if (!event?.cart?.checkout_url) errors.push("cart.checkout_url is required");
  if (typeof event?.cart?.cart_value !== "number") errors.push("cart.cart_value must be a number");
  if (!event?.campaign?.channel) errors.push("campaign.channel is required");
  if (typeof event?.campaign?.delay_minutes !== "number") {
    errors.push("campaign.delay_minutes must be a number");
  }

  return errors;
}

function validatePurchaseEvent(event) {
  const errors = [];

  if (!event || typeof event !== "object") errors.push("Event must be an object");
  if (event?.event_type !== "purchase") errors.push("event_type must be purchase");
  if (!event?.event_id) errors.push("event_id is required");
  if (!event?.store_id) errors.push("store_id is required");
  if (!event?.cart_id) errors.push("cart_id is required");
  if (!event?.order_id) errors.push("order_id is required");
  if (typeof event?.order_value !== "number") errors.push("order_value must be a number");
  if (!event?.currency) errors.push("currency is required");
  if (!event?.purchased_at) errors.push("purchased_at is required");

  return errors;
}

module.exports = {
  validateAbandonedCartEvent,
  validatePurchaseEvent
};
