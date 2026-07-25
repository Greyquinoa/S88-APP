# Render Backend Deployment Setup

Complete guide to deploy the Node.js backend on Render.

## Prerequisites

- ✅ GitHub account with S88-APP repository
- ✅ Render account (https://render.com)
- ✅ Neon PostgreSQL database ready
- ✅ Neon connection credentials

## Step 1: Create Web Service on Render

1. **Log into https://render.com**
2. **Click "+ New"** in top right
3. **Select "Web Service"**

## Step 2: Connect GitHub Repository

1. **Select "GitHub"** as repository source
2. **Search for:** `S88-APP` or your repo name
3. **Click "Connect"** next to your repository
4. **Grant Render permission** to access your GitHub

## Step 3: Configure Service Details

Fill in the following fields:

| Field | Value |
|-------|-------|
| **Name** | `s88-app-backend` |
| **Region** | Your closest region (e.g., US-East, EU-North) |
| **Branch** | `main` |
| **Runtime** | `Node` |

## Step 4: Set Build and Start Commands

1. **Build Command:**
   ```
   cd backend && npm install
   ```

2. **Start Command:**
   ```
   cd backend && npm start
   ```

3. **Auto-Deploy:** Toggle ON (deploys on every push to main)

## Step 5: Add Environment Variables

1. **Click "Advanced"** at bottom
2. **Click "Add Environment Variable"**

Add each of these (get values from Neon):

```
PGHOST = [your-neon-host].neon.tech
PGPORT = 5432
PGUSER = [your-neon-user]
PGPASSWORD = [your-neon-password]
PGDATABASE = s88_app
NODE_ENV = production
PORT = 3001
```

## Step 6: Deploy

1. **Click "Create Web Service"**
2. **Wait for deployment** (2-5 minutes)
3. **Check logs** in Render dashboard

## After Deployment

### Verify Backend is Running

Your backend URL will be: `https://s88-app-backend.onrender.com`

Test with:
```bash
curl https://s88-app-backend.onrender.com/api/projects
```

### Check Database Connection

Logs should show:
```
[DB] Connected — postgres://...
```

### Update Vercel Frontend

In Vercel environment variables, set:
```
VITE_API_BASE_URL = https://s88-app-backend.onrender.com
```

## Troubleshooting

### Service Won't Start

**Check Logs:**
1. Go to Render dashboard
2. Click your service
3. Click "Logs" tab
4. Look for error messages

**Common issues:**
- PostgreSQL connection failed → Check credentials in Environment
- Port already in use → Change PORT variable
- Missing dependencies → Check `backend/package.json`

### Database Connection Timeout

**Solution:**
1. Verify Neon is running (not paused)
2. Check database credentials are exactly correct
3. Verify Neon IP whitelist allows Render (usually automatic)
4. Test Neon connection locally first

### Service Spinning Down

Render's free tier spins down after 15 minutes of inactivity.

**To keep running:**
- Upgrade to paid tier ($7/month)
- Or call `/api/projects` periodically to keep awake

## Deploy Updates

Every time you push to GitHub main:

1. **Render automatically rebuilds**
2. **Deployment takes 2-5 minutes**
3. **Check "Deployments" tab** for status

To force redeploy:
1. Click "Manual Deploy" → "Deploy latest commit"

## Environment Variable Updates

Changes to environment variables:
1. Edit in Render dashboard
2. Click "Save"
3. Service **automatically redeploys**

## Next Steps

✅ Backend deployed on Render
→ Now deploy Frontend on Vercel (see VERCEL_SETUP.md)

