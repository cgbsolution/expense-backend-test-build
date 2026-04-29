// Cosmos DB change feed listener.
//
// Why this exists:
//   The chatbot writes expenses to Cosmos via a different backend
//   (expenseagent-dev) that we don't control. That backend has no email hooks.
//   To trigger emails for chatbot submissions WITHOUT modifying the chatbot
//   backend, we watch the Cosmos change feed directly. Whenever a new expense
//   document appears in the container — regardless of which backend wrote it
//   — we fire safeNotify(...) here.
//
// What it catches:
//   - expense.submitted   : a new doc with ApprovalStatus="Pending" appears
//   - expense.resubmitted : an existing doc moves Rejected/Draft → Pending
//   - expense.approved    : an existing doc moves Pending → Approved
//   - expense.rejected    : an existing doc moves Pending → Rejected
//
// Dedup story:
//   Each route handler also fires safeNotify directly. To avoid sending the
//   same email twice (once from the route, once from the change feed), we
//   keep an in-memory Set of dedup keys for the current process lifetime.
//   When we eventually add a Cosmos audit-log container, this becomes a
//   persistent unique constraint — for now an in-memory Set is fine.
//
// Failure modes:
//   - On startup we begin reading the feed from "Now" — meaning we never
//     replay history. Restart-window misses are accepted (we won't double-
//     email people on every deploy).
//   - If the poll loop throws, we log it and resume after the next interval.

const { ChangeFeedStartFrom } = require("@azure/cosmos");
const container = require("../cosmosClient");
const { safeNotify } = require("../notifier");

const POLL_INTERVAL_MS = 15_000; // 15s — good enough for human-perceptible email latency
const sentEvents = new Set(); // process-local dedup keys

function dedupKey(eventType, doc) {
  if (eventType === "expense.submitted" || eventType === "expense.resubmitted") {
    return `${eventType}:${doc.id}`;
  }
  // approved/rejected/sap-status keyed on the latest history entry timestamp
  // so multiple cycles don't double-fire.
  const lastAt = doc.LastActionAt || doc.ApprovedAt || doc.RejectionInfo?.RejectedAt || "";
  return `${eventType}:${doc.id}:${lastAt}`;
}

// Compare the last two entries in ApprovalHistory to figure out what just happened.
// Returns { eventType, recipient } or null if the change isn't notification-worthy.
function classifyChange(doc) {
  const history = Array.isArray(doc.ApprovalHistory) ? doc.ApprovalHistory : [];
  if (history.length === 0) return null;

  const last = history[history.length - 1];
  if (!last || last.from === last.to) return null; // no-op (e.g. SAP error log)

  // First entry => fresh submission
  if (history.length === 1 && last.from === "Start" && last.to === "Pending") {
    if (!doc.ApproverEmail) return null;
    return { eventType: "expense.submitted", recipient: doc.ApproverEmail };
  }

  // Status transitions
  if (last.from === "Pending" && last.to === "Approved") {
    if (!doc.SubmitterEmail) return null;
    return { eventType: "expense.approved", recipient: doc.SubmitterEmail };
  }
  if (last.from === "Pending" && last.to === "Rejected") {
    if (!doc.SubmitterEmail) return null;
    return { eventType: "expense.rejected", recipient: doc.SubmitterEmail };
  }
  if ((last.from === "Rejected" || last.from === "Draft") && last.to === "Pending") {
    if (!doc.ApproverEmail) return null;
    return { eventType: "expense.resubmitted", recipient: doc.ApproverEmail };
  }

  return null;
}

let iterator = null;
let polling = false;

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    if (!iterator) {
      iterator = container.items.getChangeFeedIterator({
        changeFeedStartFrom: ChangeFeedStartFrom.Now(),
      });
    }

    // Drain everything available right now, then return.
    while (iterator.hasMoreResults) {
      const response = await iterator.readNext();
      // 304 Not Modified = no new changes
      if (response.statusCode === 304) break;

      const docs = Array.isArray(response.result) ? response.result : [];
      if (docs.length === 0) break;

      console.log(`🔄 change feed: ${docs.length} doc(s)`);

      for (const doc of docs) {
        const ev = classifyChange(doc);
        if (!ev) continue;

        const key = dedupKey(ev.eventType, doc);
        if (sentEvents.has(key)) {
          console.log(`🔁 change feed: skip duplicate ${key}`);
          continue;
        }
        sentEvents.add(key);

        const ctx = { expense: doc, recipient: ev.recipient };
        if (ev.eventType === "expense.rejected") {
          ctx.reason = doc.RejectionInfo?.Reason || "";
        }

        console.log(`🔔 change feed → ${ev.eventType} for doc ${doc.id} → ${ev.recipient}`);
        // Don't await — keep the loop moving; safeNotify already swallows errors.
        safeNotify(ev.eventType, ctx);
      }
    }
  } catch (err) {
    console.error("change feed poll error:", err.message);
    // Reset iterator so a transient error doesn't permanently break us.
    iterator = null;
  } finally {
    polling = false;
  }
}

function start() {
  if (process.env.NOTIFY_CHANGEFEED_ENABLED !== "true") {
    console.log("🔄 change feed listener: DISABLED (set NOTIFY_CHANGEFEED_ENABLED=true to enable)");
    return;
  }
  console.log(`🔄 change feed listener: starting (poll every ${POLL_INTERVAL_MS}ms)`);
  // Fire-and-forget — first poll runs almost immediately.
  setTimeout(pollOnce, 1000);
  setInterval(pollOnce, POLL_INTERVAL_MS);
}

module.exports = { start };
