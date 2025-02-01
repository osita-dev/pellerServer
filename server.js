const express = require("express");
const mysql = require("mysql2/promise");
const multer = require("multer");
const path = require("path");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");

require("dotenv").config();

const app = express();
app.use(cors({ origin: "https://peller-nation.vercel.app", credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ✅ MySQL Connection Pool
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ✅ Multer Setup for File Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ["image/jpeg", "image/png", "image/gif"];
    allowedMimeTypes.includes(file.mimetype) ? cb(null, true) : cb(new Error("Only image files allowed"));
  },
});

// ✅ 1. Submit Form & Save User
app.post("/submit-form", upload.single("image"), async (req, res) => {
  const { nickname, tiktokHandle, fanSince, badge, nationality } = req.body;
  const imagePath = req.file ? req.file.path : null;
  const amount = parseInt(badge, 10);

  if (!nickname || !tiktokHandle || !badge || !nationality) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    const [result] = await db.execute(
      "INSERT INTO users (nickname, tiktokHandle, fanSince, badge, nationality, imagePath, amount) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [nickname, tiktokHandle, fanSince, badge, nationality, imagePath, amount]
    );
    res.status(201).json({ success: true, userId: result.insertId });
  } catch (error) {
    console.error("Error saving user:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// ✅ 2. Generate Paystack Payment Link
app.post("/generate-payment-link", async (req, res) => {
  const { userId, amount } = req.body;
  if (!userId || !amount) return res.status(400).json({ error: "User ID and amount required" });

  const paymentData = {
    email: "user@example.com",
    amount: amount * 100, // Paystack requires amount in kobo
    currency: "NGN",
    callback_url: `${process.env.PAYSTACK_CALLBACK_URL}?userId=${userId}`,
    reference: `PellerNation-${userId}-${Date.now()}`,
  };

  try {
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(paymentData),
    });

    const result = await response.json();
    if (response.ok && result.status && result.data.authorization_url) {
      res.status(200).json({ paymentLink: result.data.authorization_url });
    } else {
      res.status(500).json({ error: "Failed to generate payment link", details: result.message });
    }
  } catch (error) {
    console.error("Paystack API Error:", error);
    res.status(500).json({ error: "Error connecting to Paystack API" });
  }
});

// ✅ 3. Verify Paystack Payment
app.post("/verify-payment", async (req, res) => {
  const { reference, userId } = req.body;
  if (!reference || !userId) return res.status(400).json({ error: "Transaction reference or User ID missing" });

  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });

    const result = await response.json();
    if (result.status && result.data.status === "success") {
      await db.execute("UPDATE users SET isPaid = true WHERE id = ?", [userId]);
      res.status(200).json({ success: true });
    } else {
      res.status(400).json({ error: "Payment verification failed" });
    }
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ 4. Paystack Webhook
app.post("/webhook", async (req, res) => {
  const event = req.body;
  const signature = req.headers["x-paystack-signature"];

  if (!verifyPaystackSignature(signature, JSON.stringify(req.body))) {
    console.log("❌ Invalid signature");
    return res.status(400).json({ error: "Invalid Paystack signature" });
  }

  if (event.event === "charge.success") {
    console.log("✅ Payment success event received!");
    const { reference, amount, customer } = event.data;
    const amountPaid = amount / 100; // Convert kobo to NGN
    const email = customer.email;

    try {
      const [user] = await db.execute("SELECT id FROM users WHERE email = ? AND amount = ?", [email, amountPaid]);
      if (user.length > 0) {
        await db.execute("UPDATE users SET isPaid = 1 WHERE id = ?", [user[0].id]);
        console.log("✅ Payment confirmed for:", email);
        res.status(200).json({ success: true, message: "Payment confirmed" });
      } else {
        console.log("⚠️ User not found.");
        res.status(404).json({ error: "User not found" });
      }
    } catch (error) {
      console.error("🔥 Database Error:", error);
      res.status(500).json({ error: error.message });
    }
  }

  res.status(200).json({ received: true });
});

// ✅ Verify Paystack Webhook Signature
function verifyPaystackSignature(signature, body) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  const computedSignature = crypto.createHmac("sha512", secretKey).update(body).digest("hex");
  return computedSignature === signature;
}

// ✅ 5. Get User Details
app.get("/member", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ message: "User ID required" });

  try {
    const [results] = await db.execute("SELECT * FROM users WHERE id = ?", [userId]);
    results.length > 0 ? res.json(results[0]) : res.status(404).json({ message: "User not found" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// ✅ Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
