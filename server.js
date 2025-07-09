const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const Razorpay = require("razorpay");
const nodemailer = require("nodemailer");
require("dotenv").config();

// Validate required environment variables
const requiredEnvVars = [
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "EMAIL_USER",
  "EMAIL_PASS",
  "EMAIL_FROM",
  "PDF_PRICE",
  "PDF_CURRENCY",
  "PDF_NAME",
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(
  cors({
    origin: [
      "https://snapvault-pdf.netlify.app",
      "http://localhost:5173",
      "http://localhost:3000",
    ],
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

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

// Store for completed payments (in production, use a database)
const completedPayments = new Map();

// Route to create Razorpay order
app.post("/api/create-order", async (req, res) => {
  try {
    const { fullName, email, mobile } = req.body;

    // Validate required fields
    if (!fullName || !email || !mobile) {
      return res.status(400).json({
        success: false,
        message: "All fields (fullName, email, mobile) are required",
      });
    }

    // Create order options
    const options = {
      amount: parseInt(process.env.PDF_PRICE) * 100, // amount in paise
      currency: process.env.PDF_CURRENCY,
      receipt: `receipt_${Date.now()}`,
      notes: {
        fullName,
        email,
        mobile,
      },
    };

    // Create order
    const order = await razorpay.orders.create(options);

    // Store order data temporarily
    orderStore.set(order.id, {
      fullName,
      email,
      mobile,
      amount: options.amount,
      currency: options.currency,
      createdAt: new Date(),
    });

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID,
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
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body;

    // Verify signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature === razorpay_signature) {
      // Payment verified successfully
      const orderData = orderStore.get(razorpay_order_id);

      if (orderData) {
        // Generate unique download token
        const downloadToken = crypto.randomBytes(32).toString("hex");

        // Store payment completion data
        completedPayments.set(downloadToken, {
          ...orderData,
          paymentId: razorpay_payment_id,
          orderId: razorpay_order_id,
          completedAt: new Date(),
          downloaded: false,
        });

        // Send email with PDF attachment
        try {
          await sendPDFEmail(orderData, downloadToken);
          console.log("PDF email sent successfully to:", orderData.email);
        } catch (emailError) {
          console.error("Error sending email:", emailError);
          // Don't fail the payment verification if email fails
        }

        // Clean up temporary store
        orderStore.delete(razorpay_order_id);

        res.json({
          success: true,
          message: "Payment verified successfully",
          downloadUrl: `${
            process.env.BASE_URL || "http://localhost:5000"
          }/api/download-pdf/${downloadToken}`,
          downloadToken: downloadToken,
          customerData: orderData,
        });
      } else {
        res.status(400).json({
          success: false,
          message: "Order not found",
        });
      }
    } else {
      res.status(400).json({
        success: false,
        message: "Invalid signature",
      });
    }
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({
      success: false,
      message: "Payment verification failed",
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

    // Return download page HTML with both PDFs
    const downloadPageHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Download Your PDFs</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: linear-gradient(135deg, #7c3aed 0%, #f97316 100%); min-height: 100vh; }
        .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 10px; padding: 40px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        h1 { color: #333; text-align: center; margin-bottom: 30px; }
        .success-icon { text-align: center; font-size: 60px; margin-bottom: 20px; }
        .pdf-item { background: #f8f9fa; padding: 20px; margin: 15px 0; border-radius: 8px; border-left: 4px solid #7c3aed; }
        .download-btn { background: #7c3aed; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px 0; font-weight: bold; }
        .download-btn:hover { background: #6d28d9; }
        .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="success-icon">🎉</div>
        <h1>Thank You for Your Purchase!</h1>
        <p>Hi <strong>${paymentData.fullName}</strong>,</p>
        <p>Your payment was successful! Download your PDF bundle below:</p>
        
        <div class="pdf-item">
          <h3>📄 Luxury Reel Bundle</h3>
          <p>Premium collection of luxury lifestyle reel ideas</p>
          <a href="/api/download-file/${token}/1" class="download-btn">Download PDF 1</a>
        </div>
        
        <div class="pdf-item">
          <h3>📄 Premium Digital Bundle 2025</h3>
          <p>Complete digital content creation bundle for 2025</p>
          <a href="/api/download-file/${token}/2" class="download-btn">Download PDF 2</a>
        </div>
        
        <div style="background: #e7f3ff; padding: 15px; border-radius: 5px; margin: 20px 0; text-align: center;">
          <p><strong>💡 Tip:</strong> Both PDFs have also been sent to your email: <strong>${
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
    console.log(
      `Download page accessed by ${paymentData.email} at ${new Date()}`
    );
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

    let pdfPath, filename;

    if (fileNumber === "1") {
      pdfPath = path.join(__dirname, "assets", "Luxury_Reel_Bundle.pdf");
      filename = "Luxury Reel Bundle.pdf";
    } else if (fileNumber === "2") {
      pdfPath = path.join(
        __dirname,
        "assets",
        "Premium_Digital_Bundle_2025.pdf"
      );
      filename = "Premium Digital Bundle 2025.pdf";
    } else {
      return res.status(404).send("File not found");
    }

    if (!fs.existsSync(pdfPath)) {
      return res.status(404).send("PDF file not found");
    }

    // Set headers for download
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    // Send the PDF file
    res.sendFile(pdfPath, (err) => {
      if (err) {
        console.error("Error sending PDF:", err);
        res.status(500).send("Failed to download PDF");
      } else {
        console.log(
          `${filename} downloaded by ${paymentData.email} at ${new Date()}`
        );
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
    const pdfPath1 = path.join(__dirname, "assets", "Luxury_Reel_Bundle.pdf");
    const pdfPath2 = path.join(
      __dirname,
      "assets",
      "Premium_Digital_Bundle_2025.pdf"
    );

    // Check if PDF files exist
    if (!fs.existsSync(pdfPath1)) {
      throw new Error("First PDF file not found");
    }
    if (!fs.existsSync(pdfPath2)) {
      throw new Error("Second PDF file not found");
    }

    const downloadUrl = `${
      process.env.BASE_URL || "http://localhost:5000"
    }/api/download-pdf/${downloadToken}`;

    const mailOptions = {
      from: process.env.EMAIL_FROM,
      to: orderData.email,
      subject: `🎉 Your PDF Bundle Purchase - ${process.env.PDF_NAME}`,
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
              <p>Thank you for purchasing <strong>"${
                process.env.PDF_NAME
              }"</strong>!</p>
              
              <div class="pdf-bundle">
                <h3>📦 Your PDF Bundle Includes:</h3>
                <ul>
                  <li>📄 <strong>Luxury Reel Bundle</strong> - Premium collection of luxury lifestyle reel ideas</li>
                  <li>📄 <strong>Premium Digital Bundle 2025</strong> - Complete digital content creation bundle</li>
                </ul>
              </div>
              
              <p>Both PDF guides are attached to this email and you can also download them using the button below:</p>
              
              <div style="text-align: center;">
                <a href="${downloadUrl}" class="download-btn">📥 Download PDF Bundle Now</a>
              </div>
              
              <h3>What you'll get:</h3>
              <ul>
                <li>✅ 150+ trending, copyright-free content ideas</li>
                <li>✅ Proven strategies for viral content</li>
                <li>✅ Safe monetization opportunities</li>
                <li>✅ Bonus creator resources and templates</li>
                <li>✅ Lifetime access to both guides</li>
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
      attachments: [
        {
          filename: "Luxury Reel Bundle.pdf",
          path: pdfPath1,
          contentType: "application/pdf",
        },
        {
          filename: "Premium Digital Bundle 2025.pdf",
          path: pdfPath2,
          contentType: "application/pdf",
        },
      ],
    };

    await transporter.sendMail(mailOptions);
    console.log("PDF sent to:", orderData.email);

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

// Route to check download statistics (for admin use)
app.get("/api/admin/stats", (req, res) => {
  try {
    const stats = {
      totalPayments: completedPayments.size,
      totalDownloads: Array.from(completedPayments.values()).filter(
        (p) => p.downloaded
      ).length,
      recentPayments: Array.from(completedPayments.values())
        .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
        .slice(0, 10)
        .map((p) => ({
          email: p.email,
          fullName: p.fullName,
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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
