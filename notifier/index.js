// Public notifier API.
// Today: render template + send via the configured provider.
// Later (when wiring routes): add Cosmos audit log + dedup so retries/duplicate
// SAP polls can't email twice. The interface below stays the same.

const { render } = require("./render");

// Pick provider from env. Default = graph (existing M365 wiring).
//   NOTIFY_PROVIDER=graph  → notifier/provider/graph.js
//   NOTIFY_PROVIDER=smtp   → notifier/provider/smtp.js
function getProvider() {
  const name = (process.env.NOTIFY_PROVIDER || "graph").toLowerCase();
  if (name === "smtp") return require("./provider/smtp");
  if (name === "graph") return require("./provider/graph");
  throw new Error(`Unknown NOTIFY_PROVIDER: ${name}`);
}

// Pulls submitter info from the existing /employee-info endpoint so templates
// can render real names (e.g. "Tushar Ganatra") instead of raw emails.
// Always fills ctx.employee with at least { FullName: <fallback> }.
const EMPLOYEE_INFO_URL =
  process.env.EMPLOYEE_INFO_URL ||
  "https://ocr-validations-hnh3e7g2bkhhf6hq.southeastasia-01.azurewebsites.net/employee-info";

async function enrichCtx(ctx) {
  if (ctx.employee) return ctx;

  const submitterEmail = ctx.expense?.SubmitterEmail || ctx.expense?.submitterEmail || "";
  let employee = {};

  if (submitterEmail) {
    try {
      const url = `${EMPLOYEE_INFO_URL}?emp_email=${encodeURIComponent(submitterEmail)}`;
      const resp = await fetch(url);
      if (resp.ok) employee = await resp.json();
    } catch (err) {
      console.warn("enrichCtx: employee-info fetch failed:", err.message);
    }
  }

  // Fallback display name when API doesn't have one — use the part before "@".
  if (!employee.FullName) {
    employee.FullName = submitterEmail ? submitterEmail.split("@")[0] : "Submitter";
  }

  ctx.employee = employee;
  return ctx;
}

async function notify(eventType, ctx) {
  if (!ctx || !ctx.recipient) {
    throw new Error("notify() requires ctx.recipient");
  }

  await enrichCtx(ctx);

  const { subject, html } = render(eventType, ctx);
  const provider = getProvider();
  const result = await provider.send({ to: ctx.recipient, subject, html });
  return { eventType, recipient: ctx.recipient, ...result };
}

// Fire-and-forget wrapper used by HTTP route handlers.
// - Respects NOTIFY_ENABLED feature flag (no-op when "false" or unset).
// - Logs and swallows errors; the API response must never wait on or fail
//   because of email delivery.
async function safeNotify(eventType, ctx) {
  if (process.env.NOTIFY_ENABLED !== "true") return;
  if (!ctx || !ctx.recipient) {
    console.warn(`safeNotify: skipped ${eventType} (no recipient)`);
    return;
  }
  try {
    const result = await notify(eventType, ctx);
    console.log(`📧 sent ${eventType} → ${ctx.recipient}`, result.providerMessageId || "");
  } catch (err) {
    console.error(`📧 ${eventType} failed:`, err.message);
  }
}

// Maps a status transition to the right event + recipient.
// Resubmission = something that was Rejected/Draft going back to Pending.
// Returns null if the transition shouldn't trigger an email.
function pickEventForStatusChange(oldStatus, newStatus, resource) {
  if (newStatus === "Approved" && oldStatus !== "Approved") {
    return {
      type: "expense.approved",
      ctx: { expense: resource, recipient: resource.SubmitterEmail },
    };
  }
  if (newStatus === "Rejected" && oldStatus !== "Rejected") {
    return {
      type: "expense.rejected",
      ctx: {
        expense: resource,
        recipient: resource.SubmitterEmail,
        reason: resource.RejectionInfo?.Reason || "",
      },
    };
  }
  if (
    newStatus === "Pending" &&
    (oldStatus === "Rejected" || oldStatus === "Draft")
  ) {
    return {
      type: "expense.resubmitted",
      ctx: { expense: resource, recipient: resource.ApproverEmail },
    };
  }
  return null;
}

module.exports = { notify, safeNotify, pickEventForStatusChange };
