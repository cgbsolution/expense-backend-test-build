const express = require("express");
const { v4: uuidv4 } = require("uuid");
const container = require("../cosmosClient");
const multer = require("multer");
const uploadToBlob = require("../utils/blobUploader");
const { safeNotify, pickEventForStatusChange } = require("../notifier");

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

/**
 * Helper: normalize invoice payload
 */
const enrichInvoice = (inv) => ({
  ...inv,
  EMSUniqueId: inv.EMSUniqueId || uuidv4(),
  PostingDate: inv.PostingDate || new Date().toISOString().split("T")[0],
  DocumentDate: inv.DocumentDate || new Date().toISOString().split("T")[0],
  SelfApprove: inv.SelfApprove || false,
});

/**
 * @swagger
 * tags:
 *   name: MasterExpense
 *   description: APIs for managing master expenses
 */

/**
 * @swagger
 * /master-expense:
 *   post:
 *     summary: Submit a new master expense with invoices (base64 supported)
 *     tags: [MasterExpense]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ExpenseTitle
 *               - ApproverEmail
 *               - SubmitterEmail
 *               - ApprovalStatus
 *               - ExpenseData
 *             properties:
 *               ExpenseTitle: { type: string }
 *               ExpenseId: { type: string }
 *               ApproverEmail: { type: string }
 *               SubmitterEmail: { type: string }
 *               ExpenseFromDate: { type: string }
 *               ExpenseToDate: { type: string }
 *               ApprovalStatus: { type: string }
 *               SoftDelete: { type: string }
 *               ExpenseData:
 *                 type: array
 *                 items:
 *                   type: object
 *           example:   # 👈 FULL JSON example shown in Swagger
 *             ExpenseTitle: "Expense Title"
 *             ExpenseId: ""
 *             ApproverEmail: "lakshit.jain@cgbsolution.com"
 *             SubmitterEmail: "lakshit.jain@cgbsolution.com"
 *             ExpenseFromDate: ""
 *             ExpenseToDate: ""
 *             ApprovalStatus: "Pending"
 *             SoftDelete: "No"
 *             ExpenseData:
 *               - CompanyCode: "test-1000"
 *                 PostingDate: "CurrentDate"
 *                 DocumentDate: "TransactionDate in invoice"
 *                 Currency: "INR"
 *                 BillNumber: "UNNA-260278"
 *                 EMSUniqueId: "test-123"
 *                 VendorCode: "test-12345"
 *                 BusinessPlace: "test-MH01"
 *                 SectionCode: "test-1000"
 *                 Narration: "Flight from Delhi to Goa (this should be the invoice description)"
 *                 InvoiceAmount: 13850.01
 *                 SelfApprove: false
 *                 ItemData:
 *                   GLCode: "test-40503021"
 *                   TaxCode: "G0"
 *                   CostCenter: "Test-123"
 *                   WBS: "test-123"
 *                   ClaimAmount: 13850.01
 *                   HSNCode: "fetch from invoice; if not present, use any numeric code"
 *                   DocumentNo: "1900000210"
 *                 File:
 *                   - content: "(File content)"
 *                     filename: "invoice_UNNA-260278.pdf"
 *               - CompanyCode: "test-2000"
 *                 PostingDate: "CurrentDate"
 *                 DocumentDate: "TransactionDate in invoice"
 *                 Currency: "INR"
 *                 BillNumber: "HYD-459123"
 *                 EMSUniqueId: "test-456"
 *                 VendorCode: "test-67890"
 *                 BusinessPlace: "test-TN01"
 *                 SectionCode: "test-2000"
 *                 Narration: "Hotel stay in Chennai (this should be the invoice description)"
 *                 InvoiceAmount: 9500.50
 *                 SelfApprove: false
 *                 ItemData:
 *                   GLCode: "test-40504021"
 *                   TaxCode: "G0"
 *                   CostCenter: "Test-456"
 *                   WBS: "test-456"
 *                   ClaimAmount: 9500.50
 *                   HSNCode: "fetch from invoice; if not present, use any numeric code"
 *                   DocumentNo: "1900000211"
 *                 File:
 *                   - content: "(File content)"
 *                     filename: "invoice_HYD-459123.pdf"
 *     responses:
 *       200:
 *         description: Expense submitted successfully
 *       400:
 *         description: Invalid request payload
 *       500:
 *         description: Failed to submit master expense
 */
router.post("/", async (req, res) => {
  try {
    const {
      ExpenseTitle,
      ApproverEmail,
      SubmitterEmail,
      ApprovalStatus,
      ExpenseData,
    } = req.body;

    if (
      !ExpenseTitle ||
      !ApproverEmail ||
      !SubmitterEmail ||
      !ApprovalStatus ||
      !Array.isArray(ExpenseData)
    ) {
      return res.status(400).json({ error: "Invalid request payload" });
    }

    const enrichedData = ExpenseData.map(enrichInvoice);

    const totalAmount = enrichedData.reduce(
      (sum, inv) => sum + (Number(inv.InvoiceAmount) || 0),
      0
    );

    const masterExpense = {
      id: Date.now().toString(),
      ...req.body,
      SubmissionDate: new Date().toISOString(),
      TotalAmount: totalAmount,
      ExpenseData: enrichedData,
      ApprovalHistory: [
        {
          at: new Date().toISOString(),
          by: SubmitterEmail,
          from: "Start",
          to: "Pending",
          comments: "Expense submitted and parked successfully",
        },
      ],
    };

    await container.items.create(masterExpense);
    console.log(`📥 POST /master-expense saved id=${masterExpense.id} from=${SubmitterEmail} approver=${ApproverEmail}`);

    // Fire "expense.submitted" → manager. Non-blocking; obeys NOTIFY_ENABLED.
    console.log(`✉ scheduling expense.submitted → ${masterExpense.ApproverEmail}`);
    setImmediate(() =>
      safeNotify("expense.submitted", {
        expense: masterExpense,
        recipient: masterExpense.ApproverEmail,
      })
    );

    return res.status(200).json(masterExpense);
  } catch (error) {
    console.error("Error submitting master expense:", error);
    return res.status(500).json({ error: "Failed to submit master expense." });
  }
});

/**
 * @swagger
 * /master-expense:
 *   get:
 *     summary: Get master expenses by submitter email
 *     tags: [MasterExpense]
 *     parameters:
 *       - in: query
 *         name: email
 *         required: true
 *         schema:
 *           type: string
 *           example: "employee@company.com"
 *       - in: query
 *         name: approvalStatus
 *         schema:
 *           type: string
 *           example: "Approved, Draft, Pending, All"
 *     responses:
 *       200:
 *         description: List of master expenses
 *       400:
 *         description: Email is required
 *       500:
 *         description: Failed to fetch expenses
 */
router.get("/", async (req, res) => {
  const { email, approvalStatus } = req.query;
  if (!email) return res.status(400).json({ error: "Email is required" });
  console.log("Approval status ---", approvalStatus);
  try {
    let query = {};
    if (approvalStatus === "All" || approvalStatus === undefined) {
      query = {
        query: "SELECT * FROM c WHERE c.SubmitterEmail = @email ORDER BY c._ts DESC",
        parameters: [{ name: "@email", value: email }],
      };
    } else {
      query = {
        query:
          "SELECT * FROM c WHERE c.SubmitterEmail = @email AND c.ApprovalStatus = @approvalStatus",
        parameters: [
          { name: "@email", value: email },
          { name: "@approvalStatus", value: approvalStatus },
        ],
      };
    }
    console.log("query data----" + query);
    const { resources } = await container.items.query(query).fetchAll();
    return res.json(resources);
  } catch (error) {
    console.error("Error fetching expenses:", error);
    return res.status(500).json({ error: "Failed to fetch expenses." });
  }
});

/**
 * @swagger
 * /master-expense/approver:
 *   get:
 *     summary: Get master expenses where user is approver
 *     tags: [MasterExpense]
 *     parameters:
 *       - in: query
 *         name: email
 *         required: true
 *         schema:
 *           type: string
 *           example: "manager@company.com"
 *     responses:
 *       200:
 *         description: List of approver's expenses
 *       400:
 *         description: Email is required
 *       500:
 *         description: Failed to fetch expenses
 */
router.get("/approver", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Email is required" });

  try {
    const query = {
      query: "SELECT * FROM c WHERE c.ApproverEmail = @email ORDER BY c._ts DESC",
      parameters: [{ name: "@email", value: email }],
    };
    const { resources } = await container.items.query(query).fetchAll();
    return res.json(resources);
  } catch (error) {
    console.error("Error fetching approver expenses:", error);
    return res.status(500).json({ error: "Failed to fetch expenses." });
  }
});

/**
 * @swagger
 * /master-expense/counts:
 *   get:
 *     summary: Get counts of expenses by status (All, Approved, Rejected, Pending, Draft)
 *     tags: [MasterExpense]
 *     parameters:
 *       - in: query
 *         name: email
 *         required: true
 *         schema:
 *           type: string
 *           example: "employee@company.com"
 *       - in: query
 *         name: role
 *         description: Count by submitter or approver email
 *         schema:
 *           type: string
 *           enum: [submitter, approver]
 *           default: submitter
 *     responses:
 *       200:
 *         description: Count summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 all: { type: integer }
 *                 approved: { type: integer }
 *                 rejected: { type: integer }
 *                 pending: { type: integer }
 *                 draft: { type: integer }
 *       400:
 *         description: Email is required
 *       500:
 *         description: Failed to fetch counts
 */
router.get("/counts", async (req, res) => {
  const { email, role = "submitter" } = req.query;
  if (!email) return res.status(400).json({ error: "Email is required" });

  try {
    const field = role === "approver" ? "c.ApproverEmail" : "c.SubmitterEmail";

    // If you want to exclude soft-deleted records, add:
    // const softDeleteFilter = " AND (NOT IS_DEFINED(c.SoftDelete) OR c.SoftDelete != 'Yes')";
    const softDeleteFilter = "";

    const query = {
      query: `
        SELECT c.ApprovalStatus AS status, COUNT(1) AS count
        FROM c
        WHERE ${field} = @email${softDeleteFilter}
        GROUP BY c.ApprovalStatus
      `,
      parameters: [{ name: "@email", value: email }],
    };

    const { resources } = await container.items.query(query).fetchAll();

    // Build a map from status -> count
    const map = resources.reduce((acc, row) => {
      const key = (row.status || "").toString();
      acc[key] = Number(row.count) || 0;
      return acc;
    }, {});

    const approved = map["Approved"] || 0;
    const rejected = map["Rejected"] || 0;
    const pending = map["Pending"] || 0;
    const draft = map["Draft"] || 0;
    const all = Object.values(map).reduce((s, n) => s + n, 0);

    return res.json({
      all,
      approved,
      rejected,
      pending,
      draft,
    });
  } catch (error) {
    console.error("Error fetching counts:", error);
    return res.status(500).json({ error: "Failed to fetch counts." });
  }
});

/**
 * @swagger
 * /master-expense/non-self-approve:
 *   get:
 *     summary: Get master expenses containing non-self-approved invoices
 *     tags: [MasterExpense]
 *     parameters:
 *       - in: query
 *         name: email
 *         required: true
 *         schema:
 *           type: string
 *           example: "manager@company.com"
 *     responses:
 *       200:
 *         description: List of expenses
 *       400:
 *         description: Email is required
 *       500:
 *         description: Failed to fetch expenses
 */
router.get("/non-self-approve", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Email is required" });

  try {
    const query = {
      query: "SELECT DISTINCT VALUE c FROM c JOIN t IN c.ExpenseData WHERE c.ApproverEmail = @email AND c.ApprovalStatus = 'Pending' AND t.SelfApprove = false ORDER BY c._ts DESC",
      parameters: [{ name: "@email", value: email }],
    };
    const { resources } = await container.items.query(query).fetchAll();
    return res.json(resources);
  } catch (error) {
    console.error("Error fetching non-self-approved expenses:", error);
    return res.status(500).json({ error: "Failed to fetch expenses." });
  }
});

/**
 * @swagger
 * /master-expense/{id}:
 *   put:
 *     summary: Update the status of a master expense
 *     tags: [MasterExpense]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           example: "1693578428123"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ApprovalStatus]
 *             properties:
 *               ApprovalStatus: { type: string }
 *           example:
 *             ApprovalStatus: "Approved"
 *     responses:
 *       200:
 *         description: Status updated successfully
 *       400:
 *         description: ApprovalStatus is required
 *       404:
 *         description: Expense not found
 *       500:
 *         description: Failed to update expense
 */
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { ApprovalStatus, UpdatedBy, Comments, RejectionReason, ApprovalApiResponse } = req.body;

  if (!ApprovalStatus) {
    return res.status(400).json({ error: "ApprovalStatus is required" });
  }

  try {
    const { resource } = await container.item(id, id).read();
    if (!resource) {
      return res.status(404).json({ error: "Expense not found" });
    }

    const oldStatus = resource.ApprovalStatus || "Pending";
    const now = new Date().toISOString();
    
    // Create history entry
    const newEntry = {
      at: now,
      by: UpdatedBy || resource.ApproverEmail || "Unknown",
      from: oldStatus,
      to: ApprovalStatus,
      comments: Comments || (ApprovalStatus === "Approved" ? "Approved by Manager" : "Status Update"),
    };

    resource.LastActionAt = now;

    if (ApprovalStatus === "Approved") {
      newEntry.action_status = "Forwarding to Finance";
      if (!newEntry.comments) newEntry.comments = `Approved by ${newEntry.by}, forwarded to Finance Department`;
      resource.ApprovedAt = now;
      if (ApprovalApiResponse) {
        resource.ApprovalApiResponse = ApprovalApiResponse;
      }
    } else if (ApprovalStatus === "Rejected") {
      newEntry.action_status = "Rejected by Manager";
      newEntry.reason = RejectionReason || "No reason provided";
      if (!newEntry.comments) newEntry.comments = `Rejected by ${newEntry.by}. ${newEntry.reason}`;
      
      resource.RejectionInfo = {
        Reason: newEntry.reason,
        Comments: newEntry.comments,
        RejectedAt: now,
        RejectedBy: newEntry.by
      };
    }

    resource.ApprovalStatus = ApprovalStatus;
    if (!resource.ApprovalHistory) {
      resource.ApprovalHistory = [];
    }
    resource.ApprovalHistory.push(newEntry);

    await container.item(id, id).replace(resource);
    console.log(`🔁 PUT /master-expense/${id} status ${oldStatus} → ${ApprovalStatus} by=${UpdatedBy || resource.ApproverEmail}`);

    // Notify on Approved / Rejected / Resubmitted-back-to-Pending
    const ev = pickEventForStatusChange(oldStatus, ApprovalStatus, resource);
    if (ev) {
      console.log(`✉ scheduling ${ev.type} → ${ev.ctx?.recipient}`);
      setImmediate(() => safeNotify(ev.type, ev.ctx));
    } else {
      console.log(`✉ no notification event for transition ${oldStatus} → ${ApprovalStatus}`);
    }

    return res.json(resource);
  } catch (error) {
    console.error("Error updating status:", error);
    return res.status(500).json({ error: "Failed to update expense status." });
  }
});

/**
 * @swagger
 * /master-expense/by-id/{id}:
 *   put:
 *     summary: Update ApprovalStatus of a master expense by id (no PK needed)
 *     tags:
 *       - MasterExpense
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           example: "1693578428123"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ApprovalStatus
 *             properties:
 *               ApprovalStatus:
 *                 type: string
 *                 enum: [Approved, Rejected, Pending, Draft]
 *                 example: Approved
 *     responses:
 *       '200':
 *         description: ApprovalStatus updated
 *       '400':
 *         description: ApprovalStatus is required or invalid
 *       '404':
 *         description: Not found
 */

// GET /master-expense/by-id/:id
router.put("/by-id/:id", async (req, res) => {
  const { id } = req.params;
  const { ApprovalStatus, UpdatedBy, Comments, RejectionReason, ApprovalApiResponse } = req.body;

  if (!ApprovalStatus) {
    return res.status(400).json({ error: "ApprovalStatus is required" });
  }

  try {
    // Fetch the document first (SQL query, no PK needed)
    const { resources } = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: id }],
      })
      .fetchAll();

    if (!resources.length) {
      return res.status(404).json({ error: "Expense not found" });
    }

    const doc = resources[0];
    const oldStatus = doc.ApprovalStatus || "Pending";
    const now = new Date().toISOString();

    // Create history entry
    const newEntry = {
      at: now,
      by: UpdatedBy || doc.ApproverEmail || "Unknown",
      from: oldStatus,
      to: ApprovalStatus,
      comments: Comments || (ApprovalStatus === "Approved" ? "Approved by Manager" : "Status Update"),
    };

    doc.LastActionAt = now;

    if (ApprovalStatus === "Approved") {
      newEntry.action_status = "Forwarding to Finance";
       if (!newEntry.comments) newEntry.comments = `Approved by ${newEntry.by}, forwarded to Finance Department`;
       doc.ApprovedAt = now;
       if (ApprovalApiResponse) {
         doc.ApprovalApiResponse = ApprovalApiResponse;
       }
    } else if (ApprovalStatus === "Rejected") {
      newEntry.action_status = "Rejected by Manager";
      newEntry.reason = RejectionReason || "No reason provided";
       if (!newEntry.comments) newEntry.comments = `Rejected by ${newEntry.by}. ${newEntry.reason}`;
       
       doc.RejectionInfo = {
         Reason: newEntry.reason,
         Comments: newEntry.comments,
         RejectedAt: now,
         RejectedBy: newEntry.by
       };
    }

    doc.ApprovalStatus = ApprovalStatus;
    if (!doc.ApprovalHistory) {
      doc.ApprovalHistory = [];
    }
    doc.ApprovalHistory.push(newEntry);

    // Save the updated document back
    const { resource } = await container.items.upsert(doc);
    console.log(`🔁 PUT /master-expense/by-id/${id} status ${oldStatus} → ${ApprovalStatus} by=${UpdatedBy || resource.ApproverEmail}`);

    // Notify on Approved / Rejected / Resubmitted-back-to-Pending
    const ev = pickEventForStatusChange(oldStatus, ApprovalStatus, resource);
    if (ev) {
      console.log(`✉ scheduling ${ev.type} → ${ev.ctx?.recipient}`);
      setImmediate(() => safeNotify(ev.type, ev.ctx));
    } else {
      console.log(`✉ no notification event for transition ${oldStatus} → ${ApprovalStatus}`);
    }

    return res.json(resource);
  } catch (err) {
    console.error("Error updating ApprovalStatus:", err);
    return res.status(500).json({ error: "Failed to update ApprovalStatus." });
  }
});

/**
 * @swagger
 * /master-expense/upload/image:
 *   post:
 *     summary: Upload an image to Azure Blob Storage
 *     tags: [Uploads]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       '200':
 *         description: Uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *                   example: "https://<account>.blob.core.windows.net/expenses/uuid-filename.jpg"
 *       '400':
 *         description: File not provided
 *       '500':
 *         description: Upload failed
 */
router.post("/upload/image", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file provided" });
    }

    // Call your blob uploader util
    const { buffer, originalname, mimetype, size } = req.file;
    const result = await uploadToBlob(buffer, originalname, mimetype);

    // Prefer sasUrl since your account forbids public access
    return res.status(200).json({
      fileName: result.fileName,
      size,
      contentType: mimetype,
      url: result.url,        // plain (may 403)
      sasUrl: result.sasUrl,  // signed (should work)
      // use sasUrl on client to display/download
    });
  } catch (err) {
    console.error("Upload route error:", err.message);
    return res.status(500).json({ error: "Failed to upload image" });
  }
});




/**
 * @swagger
 * /master-expense/get-sas-url:
 *   post:
 *     summary: Generate a SAS URL for a specific file
 *     tags: [MasterExpense]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - url
 *             properties:
 *               url:
 *                 type: string
 *                 example: "https://<account>.blob.core.windows.net/expenses/filename"
 *     responses:
 *       200:
 *         description: SAS URL generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sasUrl:
 *                   type: string
 *       400:
 *         description: URL is required
 *       500:
 *         description: Failed to generate SAS URL
 */
router.post("/get-sas-url", async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  try {
    const sasUrl = uploadToBlob.getSasUrlFromBlobUrl(url);
    if (!sasUrl) {
      return res.status(400).json({ error: "Invalid URL or failed to generate SAS" });
    }
    return res.json({ sasUrl });
  } catch (error) {
    console.error("Error generating SAS URL:", error);
    return res.status(500).json({ error: "Failed to generate SAS URL" });
  }
});

/**
 * @swagger
 * /master-expense/notify:
 *   post:
 *     summary: Lightweight notification trigger (no Cosmos write)
 *     description: |
 *       Used by chatbot frontend after expenseagent-dev has already saved the expense.
 *       Resolves the recipient automatically when omitted: manager-lookup for
 *       `expense.submitted`/`expense.resubmitted`, submitter for `expense.approved`/`expense.rejected`.
 *     tags: [MasterExpense]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - eventType
 *               - expense
 *             properties:
 *               eventType:
 *                 type: string
 *                 enum: [expense.submitted, expense.resubmitted, expense.approved, expense.rejected]
 *               expense:
 *                 type: object
 *               recipient:
 *                 type: string
 *                 description: Optional. Auto-resolved if omitted.
 *     responses:
 *       200: { description: Notification accepted }
 *       400: { description: Missing fields or no recipient resolvable }
 */
const EMPLOYEE_INFO_URL =
  process.env.EMPLOYEE_INFO_URL ||
  "https://ocr-validations-hnh3e7g2bkhhf6hq.southeastasia-01.azurewebsites.net/employee-info";

async function lookupManagerEmail(submitterEmail) {
  if (!submitterEmail) return "";
  try {
    const url = `${EMPLOYEE_INFO_URL}?emp_email=${encodeURIComponent(submitterEmail)}`;
    const resp = await fetch(url);
    if (!resp.ok) return "";
    const info = await resp.json();
    return info?.ManagerEmail || "";
  } catch (e) {
    console.warn("lookupManagerEmail failed:", e.message);
    return "";
  }
}

router.post("/notify", async (req, res) => {
  try {
    const { eventType, expense, recipient } = req.body || {};
    if (!eventType || !expense) {
      return res.status(400).json({ error: "eventType and expense are required" });
    }
    console.log(`📬 POST /master-expense/notify event=${eventType} explicitRecipient=${recipient || "(none)"}`);

    let to = recipient || "";
    if (!to) {
      if (eventType === "expense.submitted" || eventType === "expense.resubmitted") {
        to = await lookupManagerEmail(expense.SubmitterEmail);
      } else if (eventType === "expense.approved" || eventType === "expense.rejected") {
        to = expense.SubmitterEmail || "";
      }
    }

    if (!to) {
      return res.status(400).json({ error: "Could not resolve recipient. Pass `recipient` explicitly or ensure SubmitterEmail is set." });
    }

    // Make sure the templates have what they need
    const expenseForTemplate = {
      ...expense,
      ApproverEmail: expense.ApproverEmail || (eventType.startsWith("expense.submitted") || eventType === "expense.resubmitted" ? to : expense.ApproverEmail),
    };

    setImmediate(() =>
      safeNotify(eventType, { expense: expenseForTemplate, recipient: to })
    );

    return res.status(200).json({ accepted: true, recipient: to });
  } catch (err) {
    console.error("Error in /notify:", err);
    return res.status(500).json({ error: "Failed to enqueue notification" });
  }
});

module.exports = router;
