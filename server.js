const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { Cashfree, CFEnvironment } = require("cashfree-pg");
const nodemailer = require("nodemailer");
require("dotenv").config();

// Validate required environment variables
const requiredEnvVars = [
  "CASHFREE_APP_ID",
  "CASHFREE_SECRET_KEY",
  "EMAIL_USER",
  "EMAIL_PASS",
  "EMAIL_FROM",
  "PDF_CURRENCY",
  "STARTER_PACK_PRICE",
  "PRO_PACK_PRICE",
  "COMBO_PACK_PRICE",
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const app = express();
const port = process.env.PORT || 5000;

// Get allowed origins from environment variables
const getAllowedOrigins = () => {
  // Default development origins
  const defaultOrigins = [
    "https://snapvault-in.netlify.app",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://localhost:4173",
  ];

  // Get production/custom origins from environment
  const envOrigins = [];

  // Check for FRONTEND_URL (main production URL)
  if (process.env.FRONTEND_URL) {
    envOrigins.push(process.env.FRONTEND_URL);
  }

  // Check for additional allowed origins (comma-separated)
  if (process.env.ALLOWED_ORIGINS) {
    const additionalOrigins = process.env.ALLOWED_ORIGINS.split(",").map(
      (url) => url.trim()
    );
    envOrigins.push(...additionalOrigins);
  }

  // Combine default development origins with environment origins
  const allOrigins = [...new Set([...defaultOrigins, ...envOrigins])];

  return allOrigins;
};

// Middleware
app.use(
  cors({
    origin: getAllowedOrigins(),
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Cashfree
const cashfree = new Cashfree();

// Set credentials after initialization
cashfree.XClientId = process.env.CASHFREE_APP_ID;
cashfree.XClientSecret = process.env.CASHFREE_SECRET_KEY;
cashfree.XEnvironment =
  process.env.CASHFREE_ENVIRONMENT === "PRODUCTION"
    ? CFEnvironment.PRODUCTION
    : CFEnvironment.SANDBOX;

console.log(
  "Cashfree Environment:",
  process.env.CASHFREE_ENVIRONMENT || "SANDBOX"
);

// Email transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Verify email configuration on startup
transporter.verify((error, success) => {
  if (error) {
    console.log("Email configuration error:", error);
  } else {
    console.log("Email server is ready to send messages");
  }
});

// Store for temporary order data (in production, use a database)
const orderStore = new Map();

// Store for completed payments (temporary, in-memory only)
const completedPayments = new Map();

// Flag to prevent critical operations during server restart
let isProcessingPayment = false;

// Clean up old orders from orderStore (run every 30 minutes)
setInterval(() => {
  const now = new Date();
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

  let cleanedCount = 0;
  for (const [orderId, orderData] of orderStore.entries()) {
    if (orderData.createdAt < thirtyMinutesAgo) {
      orderStore.delete(orderId);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    console.log(
      `🧹 Cleaned up ${cleanedCount} old orders from orderStore. Remaining: ${orderStore.size}`
    );
  }
}, 30 * 60 * 1000); // Run every 30 minutes

// Define package configurations
const packageConfigs = {
  "Starter Viral Pack": {
    price: parseInt(process.env.STARTER_PACK_PRICE) || 49,
    pdfs: ["Luxury_Reel_Bundle.pdf"],
    description: "75+ viral content ideas + Bonus 5 tools",
  },
  "Pro Viral Pack": {
    price: parseInt(process.env.PRO_PACK_PRICE) || 49,
    pdfs: ["Premium_Digital_Bundle_2025.pdf"],
    description: "150+ viral content ideas + 10+ bonus tools",
  },
  "Special Combo Deal": {
    price: parseInt(process.env.COMBO_PACK_PRICE) || 89,
    pdfs: ["Luxury_Reel_Bundle.pdf", "Premium_Digital_Bundle_2025.pdf"],
    description: "Complete bundle with 225+ content ideas",
  },
};

// Route to create Cashfree order
app.post("/api/create-order", async (req, res) => {
  try {
    const { fullName, email, mobile, packageName } = req.body;

    // Validate required fields
    if (!fullName || !email || !mobile || !packageName) {
      return res.status(400).json({
        success: false,
        message:
          "All fields (fullName, email, mobile, packageName) are required",
      });
    }

    // Validate package name
    if (!packageConfigs[packageName]) {
      return res.status(400).json({
        success: false,
        message: "Invalid package selected",
      });
    }

    const selectedPackage = packageConfigs[packageName];

    // Generate unique order ID
    const orderId = `order_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    // Create Cashfree order
    const orderRequest = {
      order_id: orderId,
      order_amount: selectedPackage.price,
      order_currency: process.env.PDF_CURRENCY || "INR",
      customer_details: {
        customer_id: `cust_${Date.now()}`,
        customer_name: fullName,
        customer_email: email,
        customer_phone: mobile,
      },
      order_meta: {
        return_url: `${
          process.env.FRONTEND_URL || "http://localhost:5173"
        }/download-success`,
        notify_url: `${
          process.env.BACKEND_URL || "http://localhost:5000"
        }/api/webhook`,
      },
      order_note: `Purchase of ${packageName}`,
    };

    const response = await cashfree.PGCreateOrder(orderRequest);

    // Store order data temporarily
    orderStore.set(orderId, {
      fullName,
      email,
      mobile,
      packageName,
      pdfs: selectedPackage.pdfs,
      amount: selectedPackage.price,
      currency: process.env.PDF_CURRENCY || "INR",
      createdAt: new Date(),
      paymentSessionId: response.data.payment_session_id,
    });

    res.json({
      success: true,
      orderId: orderId,
      amount: selectedPackage.price,
      currency: process.env.PDF_CURRENCY || "INR",
      paymentSessionId: response.data.payment_session_id,
      environment: process.env.CASHFREE_ENVIRONMENT || "SANDBOX",
    });
  } catch (error) {
    console.error("Error creating order:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create order",
    });
  }
});

// Route to verify payment
app.post("/api/verify-payment", async (req, res) => {
  try {
    isProcessingPayment = true;
    const { orderId, paymentSessionId } = req.body;

    // Get order data
    const orderData = orderStore.get(orderId);

    if (!orderData) {
      return res.status(400).json({
        success: false,
        message: "Order not found or expired. Please try creating a new order.",
      });
    }

    // Verify payment status with Cashfree
    let paymentDetails;

    // Try without API version parameter
    try {
      paymentDetails = await cashfree.PGOrderFetchPayments(orderId);
    } catch (api4Error) {
      console.error("Error without API version:", api4Error.message);
      throw new Error(`All API calls failed. Last error: ${api4Error.message}`);
    }

    if (paymentDetails.data && paymentDetails.data.length > 0) {
      const payment = paymentDetails.data[0];

      if (payment.payment_status === "SUCCESS") {
        // Payment verified successfully
        const downloadToken = crypto.randomBytes(32).toString("hex");

        // Store payment completion data
        completedPayments.set(downloadToken, {
          ...orderData,
          paymentId: payment.cf_payment_id,
          orderId: orderId,
          completedAt: new Date(),
          downloaded: false,
        });

        // Send email with PDF attachment
        try {
          await sendPDFEmail(orderData, downloadToken);
        } catch (emailError) {
          console.error("Error sending email:", emailError);
          // Don't fail the payment verification if email fails
        }

        // Clean up temporary store
        orderStore.delete(orderId);

        isProcessingPayment = false;

        res.json({
          success: true,
          message: "Payment verified successfully",
          downloadUrl: `${
            process.env.BASE_URL || "http://localhost:5000"
          }/api/download-pdf/${downloadToken}`,
          directDownloadUrls: orderData.pdfs.map((pdfFile, index) => ({
            url: `${
              process.env.BASE_URL || "http://localhost:5000"
            }/api/download-file/${downloadToken}/${index + 1}`,
            filename:
              pdfFile === "Luxury_Reel_Bundle.pdf"
                ? "Luxury Reel Bundle.pdf"
                : "Premium Digital Bundle 2025.pdf",
            index: index + 1,
          })),
          downloadToken: downloadToken,
          customerData: orderData,
        });
      } else {
        isProcessingPayment = false;
        res.status(400).json({
          success: false,
          message: "Payment failed or pending",
        });
      }
    } else {
      isProcessingPayment = false;
      res.status(400).json({
        success: false,
        message: "No payment found for this order",
      });
    }
  } catch (error) {
    isProcessingPayment = false;
    console.error("=== Payment Verification Error ===");
    console.error("Error message:", error.message);
    console.error("Error code:", error.code);
    console.error("Error status:", error.status);

    // Only log the stack trace without circular references
    if (error.stack) {
      console.error("Error stack:", error.stack);
    }

    // If it's a Cashfree API error, log the response details safely
    if (error.response) {
      console.error("API Error Status:", error.response.status);
      console.error("API Error Data:", error.response.data);
    }

    res.status(500).json({
      success: false,
      message: "Payment verification failed",
      error: error.message,
    });
  }
});

// Route to download PDF with token verification
app.get("/api/download-pdf/:token", (req, res) => {
  try {
    const { token } = req.params;

    // Verify download token
    const paymentData = completedPayments.get(token);
    if (!paymentData) {
      return res.status(404).json({
        success: false,
        message: "Invalid or expired download link",
      });
    }

    // Check if PDF files exist
    const pdfPath1 = path.join(__dirname, "assets", "Luxury_Reel_Bundle.pdf");
    const pdfPath2 = path.join(
      __dirname,
      "assets",
      "Premium_Digital_Bundle_2025.pdf"
    );

    if (!fs.existsSync(pdfPath1) || !fs.existsSync(pdfPath2)) {
      return res.status(404).json({
        success: false,
        message: "PDF files not found",
      });
    }

    // Mark as downloaded
    paymentData.downloaded = true;
    paymentData.downloadedAt = new Date();
    completedPayments.set(token, paymentData);

    // Return download page HTML with appropriate PDFs
    const generatePDFItems = (pdfs) => {
      return pdfs
        .map((pdfFile, index) => {
          const fileNumber = index + 1;
          let title, description;

          if (pdfFile === "Luxury_Reel_Bundle.pdf") {
            title = "📄 Luxury Reel Bundle";
            description = "Premium collection of luxury lifestyle reel ideas";
          } else if (pdfFile === "Premium_Digital_Bundle_2025.pdf") {
            title = "📄 Premium Digital Bundle 2025";
            description = "Complete digital content creation bundle for 2025";
          }

          return `
          <div class="pdf-item">
            <h3>${title}</h3>
            <p>${description}</p>
            <a href="/api/download-file/${token}/${fileNumber}" class="download-btn">Download PDF ${fileNumber}</a>
          </div>
        `;
        })
        .join("");
    };

    const downloadPageHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Download Your PDFs</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * { box-sizing: border-box; }
        body { 
          font-family: Arial, sans-serif; 
          margin: 0; 
          padding: 10px; 
          background: linear-gradient(135deg, #7c3aed 0%, #f97316 100%); 
          min-height: 100vh;
          line-height: 1.6;
        }
        .container { 
          max-width: 600px; 
          margin: 0 auto; 
          background: white; 
          border-radius: 10px; 
          padding: 20px; 
          box-shadow: 0 10px 30px rgba(0,0,0,0.2); 
        }
        @media (min-width: 768px) {
          .container { padding: 40px; }
          body { padding: 20px; }
        }
        h1 { 
          color: #333; 
          text-align: center; 
          margin-bottom: 20px;
          font-size: 1.5rem;
        }
        @media (min-width: 768px) {
          h1 { 
            margin-bottom: 30px;
            font-size: 2rem;
          }
        }
        .success-icon { 
          text-align: center; 
          font-size: 40px; 
          margin-bottom: 15px; 
        }
        @media (min-width: 768px) {
          .success-icon { 
            font-size: 60px; 
            margin-bottom: 20px; 
          }
        }
        .pdf-item { 
          background: #f8f9fa; 
          padding: 15px; 
          margin: 10px 0; 
          border-radius: 8px; 
          border-left: 4px solid #7c3aed; 
        }
        @media (min-width: 768px) {
          .pdf-item { 
            padding: 20px; 
            margin: 15px 0; 
          }
        }
        .pdf-item h3 {
          margin: 0 0 8px 0;
          font-size: 1.1rem;
        }
        .pdf-item p {
          margin: 0 0 12px 0;
          color: #666;
          font-size: 0.9rem;
        }
        .download-btn { 
          background: #7c3aed; 
          color: white; 
          padding: 10px 20px; 
          text-decoration: none; 
          border-radius: 5px; 
          display: inline-block; 
          margin: 8px 0; 
          font-weight: bold;
          font-size: 0.9rem;
          width: 100%;
          text-align: center;
          transition: all 0.3s ease;
        }
        @media (min-width: 768px) {
          .download-btn { 
            padding: 12px 25px; 
            margin: 10px 0;
            width: auto;
            font-size: 1rem;
          }
        }
        .download-btn:hover { 
          background: #6d28d9; 
          transform: translateY(-2px);
        }
        .footer { 
          text-align: center; 
          margin-top: 20px; 
          color: #666; 
          font-size: 12px; 
        }
        @media (min-width: 768px) {
          .footer { 
            margin-top: 30px; 
            font-size: 14px; 
          }
        }
        .package-info { 
          background: #e7f3ff; 
          padding: 12px; 
          border-radius: 5px; 
          margin: 15px 0; 
          text-align: center; 
        }
        @media (min-width: 768px) {
          .package-info { 
            padding: 15px; 
            margin: 20px 0; 
          }
        }
        .package-info h3 {
          margin: 0 0 8px 0;
          font-size: 1.1rem;
        }
        .package-info p {
          margin: 0;
          font-size: 0.9rem;
        }
        .tip-box {
          background: #e7f3ff; 
          padding: 12px; 
          border-radius: 5px; 
          margin: 15px 0; 
          text-align: center;
          font-size: 0.9rem;
        }
        @media (min-width: 768px) {
          .tip-box { 
            padding: 15px; 
            margin: 20px 0; 
            font-size: 1rem;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="success-icon">🎉</div>
        <h1>Thank You for Your Purchase!</h1>
        <p>Hi <strong>${paymentData.fullName}</strong>,</p>
        <p>Your payment was successful! Download your PDF(s) below:</p>
        
        <div class="package-info">
          <h3>📦 ${paymentData.packageName}</h3>
          <p>Your selected package is ready for download</p>
        </div>
        
        ${generatePDFItems(
          paymentData.pdfs || [
            "Luxury_Reel_Bundle.pdf",
            "Premium_Digital_Bundle_2025.pdf",
          ]
        )}
        
        <div class="tip-box">
          <p><strong>💡 Tip:</strong> Your PDF(s) have also been sent to your email: <strong>${
            paymentData.email
          }</strong></p>
        </div>
        
        <div class="footer">
          <p>Order ID: ${paymentData.orderId || "N/A"}</p>
          <p>Download completed at: ${new Date().toLocaleString()}</p>
        </div>
      </div>
    </body>
    </html>
    `;

    res.send(downloadPageHTML);
  } catch (error) {
    console.error("Error accessing download page:", error);
    res.status(500).json({
      success: false,
      message: "Failed to access downloads",
    });
  }
});

// Route to download individual PDF files
app.get("/api/download-file/:token/:fileNumber", (req, res) => {
  try {
    const { token, fileNumber } = req.params;

    // Verify download token
    const paymentData = completedPayments.get(token);
    if (!paymentData) {
      return res.status(404).send("Invalid or expired download link");
    }

    const fileIndex = parseInt(fileNumber) - 1;
    const userPdfs = paymentData.pdfs || [
      "Luxury_Reel_Bundle.pdf",
      "Premium_Digital_Bundle_2025.pdf",
    ];

    if (fileIndex < 0 || fileIndex >= userPdfs.length) {
      return res.status(404).send("File not found");
    }

    const pdfFileName = userPdfs[fileIndex];
    const pdfPath = path.join(__dirname, "assets", pdfFileName);

    let displayName;
    if (pdfFileName === "Luxury_Reel_Bundle.pdf") {
      displayName = "Luxury Reel Bundle.pdf";
    } else if (pdfFileName === "Premium_Digital_Bundle_2025.pdf") {
      displayName = "Premium Digital Bundle 2025.pdf";
    } else {
      displayName = pdfFileName;
    }

    if (!fs.existsSync(pdfPath)) {
      return res.status(404).send("PDF file not found");
    }

    // Set headers for download
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${displayName}"`
    );

    // Send the PDF file
    res.sendFile(pdfPath, (err) => {
      if (err) {
        console.error("Error sending PDF:", err);
        res.status(500).send("Failed to download PDF");
      } else {
      }
    });
  } catch (error) {
    console.error("Error downloading individual PDF:", error);
    res.status(500).send("Failed to download PDF");
  }
});

// Function to send PDF via email
async function sendPDFEmail(orderData, downloadToken) {
  try {
    const userPdfs = orderData.pdfs || [
      "Luxury_Reel_Bundle.pdf",
      "Premium_Digital_Bundle_2025.pdf",
    ];
    const attachments = [];
    const pdfDescriptions = [];

    // Build attachments and descriptions based on user's package
    for (const pdfFile of userPdfs) {
      const pdfPath = path.join(__dirname, "assets", pdfFile);

      if (!fs.existsSync(pdfPath)) {
        throw new Error(`PDF file not found: ${pdfFile}`);
      }

      let filename, description;
      if (pdfFile === "Luxury_Reel_Bundle.pdf") {
        filename = "Luxury Reel Bundle.pdf";
        description =
          "📄 <strong>Luxury Reel Bundle</strong> - Premium collection of luxury lifestyle reel ideas";
      } else if (pdfFile === "Premium_Digital_Bundle_2025.pdf") {
        filename = "Premium Digital Bundle 2025.pdf";
        description =
          "📄 <strong>Premium Digital Bundle 2025</strong> - Complete digital content creation bundle";
      }

      attachments.push({
        filename: filename,
        path: pdfPath,
        contentType: "application/pdf",
      });

      pdfDescriptions.push(description);
    }

    const downloadUrl = `${
      process.env.BASE_URL || "http://localhost:5000"
    }/api/download-pdf/${downloadToken}`;

    const packageName = orderData.packageName || "PDF Bundle";
    const packageInfo = packageConfigs[packageName];

    const mailOptions = {
      from: process.env.EMAIL_FROM,
      to: orderData.email,
      subject: `🎉 Your ${packageName} Purchase - Ready for Download!`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #7c3aed, #f97316); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px; }
            .download-btn { background: #7c3aed; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 20px 0; }
            .footer { text-align: center; margin-top: 30px; font-size: 14px; color: #666; }
            .success-icon { font-size: 50px; margin-bottom: 20px; }
            .pdf-bundle { background: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #ffc107; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div class="success-icon">🎉</div>
              <h1>Payment Successful!</h1>
              <p>Thank you for your purchase</p>
            </div>
            <div class="content">
              <h2>Hi ${orderData.fullName},</h2>
              <p>Thank you for purchasing <strong>"${packageName}"</strong>!</p>
              
              <div class="pdf-bundle">
                <h3>📦 Your ${packageName} Includes:</h3>
                <ul>
                  ${pdfDescriptions.map((desc) => `<li>${desc}</li>`).join("")}
                </ul>
                ${
                  packageInfo
                    ? `<p><em>${packageInfo.description}</em></p>`
                    : ""
                }
              </div>
              
              <p>${
                userPdfs.length > 1 ? "All PDF guides are" : "Your PDF guide is"
              } attached to this email and you can also download ${
        userPdfs.length > 1 ? "them" : "it"
      } using the button below:</p>
              
              <div style="text-align: center;">
                <a href="${downloadUrl}" class="download-btn">📥 Download ${
        userPdfs.length > 1 ? "PDFs" : "PDF"
      } Now</a>
              </div>
              
              <h3>What you'll get:</h3>
              <ul>
                <li>✅ Luxury Lifestyle</li>
                <li>✅ Supercars & Private Jets</li>
                <li>✅ Fitness & Motivation</li>
                <li>✅ Business & Finance</li>
                <li>✅ Fashion & Aesthetics</li>
                <li>✅ Nature & Travel</li>
                <li>✅ Cinematic B-Rolls</li>
                <li>✅ Lo-fi & Vibes</li>
                <li>✅ Anime, Gaming, and more</li>
              </ul>
              
              <p><strong>Important:</strong> Save this email for future reference. The download links will remain active.</p>
              
              <div style="background: #e7f3ff; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <h4>📧 Need Help?</h4>
                <p>If you have any questions or need support, simply reply to this email.</p>
              </div>
              
              <p>Start creating amazing content and watch your engagement soar!</p>
              
              <p>Best regards,<br>
              <strong>Your Content Team</strong></p>
            </div>
            <div class="footer">
              <p>Order ID: ${orderData.orderId || "N/A"} | Payment ID: ${
        orderData.paymentId || "N/A"
      }</p>
              <p>This email was sent to ${orderData.email}</p>
            </div>
          </div>
        </body>
        </html>
      `,
      attachments: attachments,
    };

    await transporter.sendMail(mailOptions);
    console.log(`${packageName} PDFs sent to:`, orderData.email);

    return { success: true, message: "Email sent successfully" };
  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
}

// Health check route
app.get("/", (req, res) => {
  res.json({
    message: "SnapVault Backend API is running!",
    status: "OK",
    timestamp: new Date(),
    environment: process.env.NODE_ENV || "development",
  });
});

// Health check route
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date() });
});

// Route to get current package prices (for debugging/admin)
app.get("/api/packages", (req, res) => {
  try {
    res.json({
      success: true,
      packages: packageConfigs,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("Error getting package info:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get package information",
    });
  }
});

// Route to check download statistics (for admin use)
app.get("/api/admin/stats", (req, res) => {
  try {
    const paymentsArray = Array.from(completedPayments.values());

    // Calculate package-wise statistics
    const packageStats = {};
    paymentsArray.forEach((payment) => {
      if (!packageStats[payment.packageName]) {
        packageStats[payment.packageName] = {
          count: 0,
          revenue: 0,
        };
      }
      packageStats[payment.packageName].count++;
      packageStats[payment.packageName].revenue += payment.amount;
    });

    // Calculate daily statistics for the last 7 days
    const last7Days = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dayStart = new Date(date.setHours(0, 0, 0, 0));
      const dayEnd = new Date(date.setHours(23, 59, 59, 999));

      const dayPayments = paymentsArray.filter((p) => {
        const paymentDate = new Date(p.completedAt);
        return paymentDate >= dayStart && paymentDate <= dayEnd;
      });

      last7Days.push({
        date: dayStart.toISOString().split("T")[0],
        payments: dayPayments.length,
        revenue: dayPayments.reduce((sum, p) => sum + p.amount, 0),
      });
    }

    const stats = {
      totalPayments: completedPayments.size,
      totalRevenue: paymentsArray.reduce((sum, p) => sum + p.amount, 0),
      totalDownloads: paymentsArray.filter((p) => p.downloaded).length,
      packageStats,
      last7Days,
      recentPayments: paymentsArray
        .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
        .slice(0, 10)
        .map((p) => ({
          email: p.email,
          fullName: p.fullName,
          packageName: p.packageName,
          amount: p.amount,
          completedAt: p.completedAt,
          downloaded: p.downloaded,
          downloadedAt: p.downloadedAt,
        })),
    };

    res.json(stats);
  } catch (error) {
    console.error("Error getting stats:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get statistics",
    });
  }
});

// Private endpoint to get payment count (for admin use only)
app.get("/api/private/payment-count", (req, res) => {
  try {
    // Simple auth check - you can access this with a secret parameter
    const authKey = req.query.key || req.headers["x-auth-key"];
    const expectedKey = process.env.ADMIN_SECRET_KEY || "your-secret-key-here";

    if (authKey !== expectedKey) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    // Get today's payments
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const paymentsArray = Array.from(completedPayments.values());
    const todayPayments = paymentsArray.filter((p) => {
      const paymentDate = new Date(p.completedAt);
      return paymentDate >= today && paymentDate < tomorrow;
    });

    res.json({
      success: true,
      totalPayments: completedPayments.size,
      todayPayments: todayPayments.length,
      totalRevenue: paymentsArray.reduce((sum, p) => sum + p.amount / 100, 0),
      todayRevenue: todayPayments.reduce((sum, p) => sum + p.amount / 100, 0),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error getting payment count:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get payment count",
    });
  }
});

// Contact form submission endpoint
app.post("/contact", async (req, res) => {
  try {
    const { fullName, email, phone, issue, timestamp } = req.body;

    // Validate required fields
    if (!fullName || !email || !issue) {
      return res.status(400).json({
        success: false,
        error: "All fields (fullName, email, issue) are required",
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: "Please provide a valid email address",
      });
    }

    // Create email content for admin notification
    const adminEmailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50; border-bottom: 2px solid #e67e22; padding-bottom: 10px;">
          🆘 New Contact Form Submission
        </h2>
        
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #e67e22; margin-top: 0;">Customer Details:</h3>
          <p><strong>Name:</strong> ${fullName}</p>
          <p><strong>Email:</strong> ${email}</p>
          ${phone ? `<p><strong>Phone:</strong> ${phone}</p>` : ""}
          <p><strong>Submitted:</strong> ${new Date(
            timestamp
          ).toLocaleString()}</p>
        </div>
        
        <div style="background-color: #fff3cd; padding: 20px; border-radius: 8px; border-left: 4px solid #ffc107;">
          <h3 style="color: #856404; margin-top: 0;">Issue Description:</h3>
          <p style="color: #856404; white-space: pre-wrap;">${issue}</p>
        </div>
        
        <div style="margin-top: 30px; padding: 20px; background-color: #e8f5e8; border-radius: 8px;">
          <p style="margin: 0; color: #2d5a2d;">
            <strong>📧 Reply to:</strong> ${email}<br>
            ${phone ? `<strong>📞 Phone:</strong> ${phone}<br>` : ""}
            <strong>⏰ Response Time:</strong> Within 24 hours<br>
            <strong>🔗 Admin Dashboard:</strong> Check for recent activity
          </p>
        </div>
      </div>
    `;

    // Create auto-reply email for customer
    const customerEmailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50; border-bottom: 2px solid #e67e22; padding-bottom: 10px;">
          ✅ We've Received Your Message!
        </h2>
        
        <p>Hi ${fullName},</p>
        
        <p>Thank you for reaching out to us! We've successfully received your message and our support team has been notified.</p>
        
        <div style="background-color: #e8f5e8; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #2d5a2d; margin-top: 0;">📋 Your Message:</h3>
          <p style="color: #2d5a2d; white-space: pre-wrap; font-style: italic;">"${issue}"</p>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #495057;">⏰ What happens next?</h3>
          <ul style="color: #495057;">
            <li>Our team will review your message within 2-4 hours</li>
            <li>You'll receive a personalized response within 24 hours</li>
            <li>For urgent issues, we prioritize payment and download problems</li>
          </ul>
        </div>
        
        <p>If you have any additional information or urgent concerns, feel free to reply to this email.</p>
        
        <p style="margin-top: 30px;">
          Best regards,<br>
          <strong>Content Creator Support Team</strong> 💖<br>
          <em>We care about every creator in our community!</em>
        </p>
        
        <hr style="border: none; border-top: 1px solid #e9ecef; margin: 30px 0;">
        <p style="font-size: 12px; color: #6c757d; text-align: center;">
          This is an automated response. Please do not reply to this email address.
        </p>
      </div>
    `;

    // Configure email transporter
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    // Send admin notification email
    const adminMailOptions = {
      from: process.env.EMAIL_FROM,
      to: process.env.EMAIL_FROM, // Send to admin email
      subject: `🆘 New Contact Form: ${fullName} - ${issue.substring(
        0,
        50
      )}...`,
      html: adminEmailContent,
      replyTo: email, // Allow direct reply to customer
    };

    // Send customer auto-reply
    const customerMailOptions = {
      from: process.env.EMAIL_FROM,
      to: email,
      subject: "✅ We've received your message - Support Team",
      html: customerEmailContent,
    };

    // Send both emails
    await Promise.all([
      transporter.sendMail(adminMailOptions),
      transporter.sendMail(customerMailOptions),
    ]);

    res.json({
      success: true,
      message:
        "Your message has been sent successfully! We'll get back to you within 24 hours.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Error processing contact form:", error);

    res.status(500).json({
      success: false,
      error:
        "Failed to send your message. Please try again or email us directly.",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
