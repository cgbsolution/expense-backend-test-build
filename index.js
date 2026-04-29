const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const swaggerJsDoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ limit: "25mb", extended: true }));

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Expense Tracker API",
      version: "1.0.0",
      description: "API to manage expenses (Master Expenses, Invoices, etc.)",
    },
    servers: [
      {
        url: process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`,
      },
    ],
  },
  apis: ["./routes/*.js"], // Scan route files for swagger annotations
};

const swaggerDocs = swaggerJsDoc(swaggerOptions);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Routes
const masterExpenseRoute = require("./routes/masterExpense");
app.use("/master-expense", masterExpenseRoute);

// Health Check
app.get("/", (req, res) => {
  res.status(200).json({ status: "OK", message: "Expense Tracker API running" });
});

// 404 Handler (after all routes)
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("🔥 Server Error:", err.stack);
  res.status(500).json({ error: "Internal Server Error" });
});

// Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📖 Swagger docs available at http://localhost:${PORT}/api-docs`);

  // Start the Cosmos change feed listener so we email on chatbot-originated
  // submissions too. Gated by NOTIFY_CHANGEFEED_ENABLED env var.
  try {
    require("./pollers/cosmosChangeFeed").start();
  } catch (err) {
    console.error("Failed to start change feed listener:", err.message);
  }
});
