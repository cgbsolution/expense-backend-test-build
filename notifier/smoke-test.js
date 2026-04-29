// One-shot script: sends a single test "expense.submitted" email.
// Reads creds from .env. Does not touch any HTTP routes or Cosmos.
//
// Run from backend root:
//     npm run smoke-test:notify
//
// What "success" looks like: a 202 from Graph, then the test email arrives in
// the recipient's inbox within ~30s. If you see "AADSTS65001" or "Mail.Send",
// the AAD app is missing the delegated Mail.Send permission — see README.

require("dotenv").config();

const { notify } = require("./index");

const sampleExpense = {
  id: "smoke-test-1",
  ExpenseTitle: "Communication - WiFi Reimbursement",
  SubmitterEmail: process.env.GRAPH_USERNAME || "submitter@tatarealty.in",
  ApproverEmail: "manager@tatarealty.in",
  TotalAmount: 1982.43,
  SubmissionDate: new Date().toISOString().slice(0, 10),
  ExpenseData: [
    {
      BillNumber: "1234567890",
      ItemData: { DocumentNo: "1900002686" },
    },
  ],
};

async function main() {
  const recipient = process.env.NOTIFY_TEST_TO || process.env.GRAPH_USERNAME;
  if (!recipient) {
    throw new Error(
      "Set NOTIFY_TEST_TO (or GRAPH_USERNAME) in .env so I know where to send the test email."
    );
  }

  const provider = (process.env.NOTIFY_PROVIDER || "graph").toLowerCase();
  console.log("→ provider  :", provider);
  if (provider === "smtp") {
    console.log("→ host:port :", `${process.env.SMTP_HOST}:${process.env.SMTP_PORT}`);
    console.log("→ from      :", process.env.SMTP_FROM || process.env.SMTP_USER);
  } else {
    console.log("→ flow      :", process.env.GRAPH_AUTH_FLOW || "ropc");
    console.log("→ tenant    :", process.env.GRAPH_TENANT_ID);
    console.log("→ client    :", process.env.GRAPH_CLIENT_ID);
  }
  console.log("→ recipient :", recipient);
  console.log("→ event     :", "expense.submitted");
  console.log("");

  try {
    const result = await notify("expense.submitted", {
      expense: sampleExpense,
      recipient,
    });
    console.log("✅ sent");
    console.log(JSON.stringify(result, null, 2));
    console.log("\nCheck the recipient's inbox (and Junk folder).");
  } catch (err) {
    console.error("❌ failed:", err.message);
    if (/AADSTS65001|consent/i.test(err.message)) {
      console.error("\nHint: The AAD app needs Microsoft Graph → Delegated → Mail.Send,");
      console.error("with admin consent granted, in the Tata Realty tenant.");
    }
    if (/AADSTS50126|invalid_grant/i.test(err.message)) {
      console.error("\nHint: Username or password is wrong (or MFA is enabled — ROPC won't work with MFA).");
    }
    if (/AADSTS50076|MFA/i.test(err.message)) {
      console.error("\nHint: This account has MFA enabled. ROPC won't work — switch to GRAPH_AUTH_FLOW=client_secret.");
    }
    process.exit(1);
  }
}

main();
