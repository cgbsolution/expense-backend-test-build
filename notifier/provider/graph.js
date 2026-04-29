// Microsoft Graph email provider.
// Supports two auth flows, picked by GRAPH_AUTH_FLOW env:
//   - "ropc"          : signs in as a real user with username + password (delegated Mail.Send)
//   - "client_secret" : app-only token using client credentials (application Mail.Send)
//
// Production path is client_secret. ROPC is here so we can smoke-test with an
// existing user account before a tenant admin grants application Mail.Send.

const TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

async function fetchToken() {
  const flow = (process.env.GRAPH_AUTH_FLOW || "ropc").toLowerCase();
  const tenantId = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  if (!tenantId || !clientId) {
    throw new Error("GRAPH_TENANT_ID and GRAPH_CLIENT_ID must be set");
  }

  const params = new URLSearchParams();
  params.set("client_id", clientId);

  if (flow === "ropc") {
    const username = process.env.GRAPH_USERNAME;
    const password = process.env.GRAPH_PASSWORD;
    if (!username || !password) {
      throw new Error(
        "GRAPH_AUTH_FLOW=ropc requires GRAPH_USERNAME and GRAPH_PASSWORD"
      );
    }
    params.set("grant_type", "password");
    params.set("scope", "https://graph.microsoft.com/Mail.Send offline_access");
    params.set("username", username);
    params.set("password", password);
  } else if (flow === "client_secret") {
    const clientSecret = process.env.GRAPH_CLIENT_SECRET;
    if (!clientSecret) {
      throw new Error(
        "GRAPH_AUTH_FLOW=client_secret requires GRAPH_CLIENT_SECRET"
      );
    }
    params.set("grant_type", "client_credentials");
    params.set("client_secret", clientSecret);
    params.set("scope", "https://graph.microsoft.com/.default");
  } else {
    throw new Error(`Unsupported GRAPH_AUTH_FLOW: ${flow}`);
  }

  const resp = await fetch(TOKEN_URL(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const json = await resp.json();
  if (!resp.ok) {
    const reason = json.error_description || json.error || `HTTP ${resp.status}`;
    throw new Error(`Token request failed: ${reason}`);
  }
  return { token: json.access_token, flow };
}

// Sends one HTML email.
//   { to, subject, html }
// The "from" mailbox is implicit:
//   - ROPC          → the authenticated user (uses /me/sendMail)
//   - client_secret → GRAPH_FROM_ADDRESS (uses /users/{from}/sendMail)
async function send({ to, subject, html }) {
  if (!to || !subject || !html) {
    throw new Error("send() requires { to, subject, html }");
  }
  const { token, flow } = await fetchToken();

  let endpoint;
  if (flow === "client_secret") {
    const fromAddress = process.env.GRAPH_FROM_ADDRESS;
    if (!fromAddress) {
      throw new Error(
        "client_secret flow requires GRAPH_FROM_ADDRESS (the mailbox to send from)"
      );
    }
    endpoint = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromAddress)}/sendMail`;
  } else {
    endpoint = `https://graph.microsoft.com/v1.0/me/sendMail`;
  }

  const body = {
    message: {
      subject,
      body: { contentType: "HTML", content: html },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: true,
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  // sendMail returns 202 Accepted with no body on success.
  if (resp.status === 202) {
    return { providerMessageId: resp.headers.get("client-request-id") || null };
  }
  let detail = "";
  try { detail = await resp.text(); } catch (_) {}
  throw new Error(`Graph sendMail failed (${resp.status}): ${detail}`);
}

module.exports = { send };
