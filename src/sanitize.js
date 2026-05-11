function sanitizeProviderFailureReason(reason) {
  const text = String(reason || "Provider send failed");

  return text
    .replace(/\bAccount\s+AC[a-fA-F0-9]{32}\b/g, "Twilio account")
    .replace(/\bAC[a-fA-F0-9]{32}\b/g, "Twilio account")
    .replace(/\bSK[a-fA-F0-9]{32}\b/g, "Twilio API key")
    .replace(/\bSG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "provider API key")
    .replace(/\bshpss_[A-Za-z0-9]+\b/g, "Shopify app secret")
    .replace(/\bshpat_[A-Za-z0-9]+\b/g, "Shopify access token")
    .replace(/\bshpca_[A-Za-z0-9]+\b/g, "Shopify custom app token")
    .replace(/\b(shppa|shpua)_[A-Za-z0-9]+\b/g, "Shopify token");
}

module.exports = {
  sanitizeProviderFailureReason
};
