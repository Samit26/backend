# Backend Deployment Guide for Render

## Prerequisites
1. Create a GitHub repository for your backend code
2. Create a Render account at https://render.com

## Step-by-Step Deployment

### 1. Prepare Your Repository
```bash
# Initialize git in the backend folder
cd "d:\PDF Download\backend"
git init
git add .
git commit -m "Initial backend setup"

# Create a new repository on GitHub and push your code
git remote add origin https://github.com/YOUR_USERNAME/snapvault-backend.git
git branch -M main
git push -u origin main
```

### 2. Deploy on Render

1. **Login to Render**: Go to https://render.com and sign in
2. **Create New Web Service**: Click "New +" → "Web Service"
3. **Connect Repository**: 
   - Choose "Connect a repository"
   - Select your GitHub repository
4. **Configure Service**:
   - **Name**: `snapvault-backend`
   - **Environment**: `Node`
   - **Region**: Choose closest to your users
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`

### 3. Environment Variables
Add these environment variables in Render dashboard:

```
NODE_ENV=production
RAZORPAY_KEY_ID=rzp_test_63UQqjFQDDTzve
RAZORPAY_KEY_SECRET=dc4FJ9vsClx0qS18hp9XLPQy
EMAIL_USER=try.samitkhedekar2594@gmail.com
EMAIL_PASS=ujyt uzqk hwhn mqns
EMAIL_FROM=try.samitkhedekar2594@gmail.com
PDF_PRICE=99
PDF_CURRENCY=INR
PDF_NAME=Premium Digital Bundle 2025 + Luxury Reel Bundle
PDF_DESCRIPTION=Ultimate guide with 150+ trending, copyright-free reel/shorts
BASE_URL=https://YOUR_APP_NAME.onrender.com
FRONTEND_URL=https://snapvault-pdf.netlify.app
```

### 4. Important Notes

- **Replace `YOUR_APP_NAME`** with your actual Render app name in BASE_URL
- **Free Tier Limitations**: 
  - Service spins down after 15 minutes of inactivity
  - Cold starts may take 30+ seconds
  - Consider upgrading to paid plan for production
- **File Storage**: PDF files are included in the deployment
- **Domain**: You'll get a URL like `https://snapvault-backend.onrender.com`

### 5. Update Frontend Configuration
After deployment, update your frontend to use the new backend URL:
- Replace `http://localhost:5000` with `https://YOUR_APP_NAME.onrender.com`

### 6. Testing
Test these endpoints after deployment:
- `GET https://YOUR_APP_NAME.onrender.com/health` - Health check
- `POST https://YOUR_APP_NAME.onrender.com/api/create-order` - Order creation

### 7. Monitoring
- Check Render dashboard for logs and metrics
- Monitor email delivery
- Test payment flow end-to-end

## Alternative Deployment Options

### Railway
1. Go to https://railway.app
2. Connect GitHub repository
3. Add same environment variables
4. Deploy automatically

### Heroku
1. Install Heroku CLI
2. `heroku create snapvault-backend`
3. Set environment variables with `heroku config:set`
4. `git push heroku main`

## Troubleshooting

- **CORS Issues**: Ensure frontend URL is in CORS configuration
- **Email Issues**: Verify Gmail app password is correct
- **PDF Not Found**: Check if PDF files are included in deployment
- **Environment Variables**: Double-check all required env vars are set
