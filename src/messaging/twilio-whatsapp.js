function normalizeWhatsAppAddress(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith("whatsapp:") ? trimmed : `whatsapp:${trimmed}`;
}

function readTwilioWhatsAppConfig() {
  return {
    enabled: process.env.TWILIO_WHATSAPP_ENABLED === "true",
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    from: normalizeWhatsAppAddress(process.env.TWILIO_WHATSAPP_FROM || ""),
    testTo: normalizeWhatsAppAddress(process.env.TWILIO_TEST_WHATSAPP_TO || "")
  };
}

function validateTwilioWhatsAppConfig(config = readTwilioWhatsAppConfig()) {
  const missing = [];

  if (!config.accountSid) missing.push("TWILIO_ACCOUNT_SID");
  if (!config.authToken) missing.push("TWILIO_AUTH_TOKEN");
  if (!config.from) missing.push("TWILIO_WHATSAPP_FROM");

  return {
    ok: missing.length === 0,
    enabled: config.enabled,
    missing
  };
}

async function sendTwilioWhatsAppMessage(config, to, body) {
  const validation = validateTwilioWhatsAppConfig(config);
  if (!validation.ok) {
    throw new Error(`Twilio WhatsApp configuration is incomplete: ${validation.missing.join(", ")}`);
  }

  const normalizedTo = normalizeWhatsAppAddress(to);
  if (!normalizedTo) {
    throw new Error("Twilio WhatsApp recipient is missing");
  }

  if (!body) {
    throw new Error("Twilio WhatsApp message body is missing");
  }

  const form = new URLSearchParams();
  form.set("From", config.from);
  form.set("To", normalizedTo);
  form.set("Body", body);

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.message || payload.error_message || "Twilio WhatsApp send failed");
  }

  return {
    provider: "twilio",
    sid: payload.sid,
    status: payload.status,
    to: payload.to,
    from: payload.from,
    body: payload.body
  };
}

async function fetchTwilioWhatsAppMessageStatus(config, messageSid) {
  const validation = validateTwilioWhatsAppConfig(config);
  if (!validation.ok) {
    throw new Error(`Twilio WhatsApp configuration is incomplete: ${validation.missing.join(", ")}`);
  }

  if (!messageSid) {
    throw new Error("Twilio message SID is missing");
  }

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages/${messageSid}.json`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`
    }
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.message || payload.error_message || "Twilio WhatsApp status lookup failed");
  }

  return {
    provider: "twilio",
    sid: payload.sid,
    status: payload.status,
    error_code: payload.error_code || null,
    error_message: payload.error_message || null,
    to: payload.to,
    from: payload.from,
    date_created: payload.date_created || null,
    date_sent: payload.date_sent || null,
    date_updated: payload.date_updated || null
  };
}

module.exports = {
  fetchTwilioWhatsAppMessageStatus,
  normalizeWhatsAppAddress,
  readTwilioWhatsAppConfig,
  sendTwilioWhatsAppMessage,
  validateTwilioWhatsAppConfig
};
