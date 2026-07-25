# Vercel Frontend Deployment Setup

Complete guide to deploy the React frontend on Vercel.

## Prerequisites

- ✅ GitHub account with S88-APP repository
- ✅ Vercel account (https://vercel.com)
- ✅ Render backend already deployed (see RENDER_SETUP.md)
- ✅ Render backend URL (e.g., `https://s88-app-backend.onrender.com`)

## Step 1: Create Project on Vercel

1. **Go to https://vercel.com**
2. **Click "Add New..."** → **"Project"**
3. **Click "Import Git Repository"**

## Step 2: Connect GitHub Repository

1. **Paste GitHub URL:**
   ```
   https://github.com/Greyquinoa/S88-APP.git
   ```
2. **Click "Continue"**
3. **Click "Authorize Vercel"** (if prompted)
4. **Select your GitHub account**
5. **Search and select** your S88-APP repository

## Step 3: Configure Project Settings

1. **Project Name:** `s88-app-frontend`
2. **Framework:** Select **Vite** (or let Vercel auto-detect)

### Framework Preset (if needed)

If Vercel asks for framework, select:
- **Framework:** Vite
- **Build Command:** `npm run build`
- **Output Directory:** `dist`

### Root Directory

1. **Click "Edit"** next to Root Directory
2. **Change to:** `frontend`
3. **Click "Save"**

## Step 4: Add Environment Variables

1. **Click "Environment Variables"**
2. **Add variable:**

| Name | Value |
|------|-------|
| `VITE_API_BASE_URL` | `https://s88-app-backend.onrender.com` |

**Important:** This makes your frontend talk to your online backend

3. **Click "Add"**
4. **Click "Deploy"**

## Step 5: Deploy

1. **Wait for build and deployment** (3-5 minutes)
2. **Check deployment status** on dashboard
3. **Once complete, Vercel shows your URL**

Your frontend URL will be: `https://s88-app-frontend.vercel.app`

(or custom domain if configured)

## After Deployment

### Test the Frontend

1. **Open:** `https://s88-app-frontend.vercel.app`
2. **Check browser console** (F12 → Console) for errors
3. **Try basic actions** (create project, import data, etc.)

### Check Environment Variable

In browser console:
```javascript
console.log(import.meta.env.VITE_API_BASE_URL)
// Should show: https://s88-app-backend.onrender.com
```

### Monitor Deployment

1. **Click "Deployments" tab**
2. **Click latest deployment** for details
3. **Click "Logs"** to see build output

## Troubleshooting

### CORS Errors in Browser

**Error in console:**
```
Access to XMLHttpRequest at 'https://s88-app-backend.onrender.com/api/...'
(blocked by CORS policy)
```

**Solution:**
1. Update backend CORS (see RENDER_SETUP.md)
2. Add Vercel domain to CORS whitelist
3. Edit `backend/src/server.js`:

```javascript
const cors = require('cors');
app.use(cors({
  origin: [
    'http://localhost:5173',  // local dev
    'https://s88-app-frontend.vercel.app'  // production
  ],
  credentials: true
}));
```

4. Redeploy backend on Render

### Build Fails

**Check logs:**
1. Click deployment
2. Click "View Build Logs"
3. Look for error messages

**Common issues:**
- TypeScript errors → Fix `.tsx` files
- Missing dependency → Run `npm install` locally
- Wrong environment variable → Check VITE_API_BASE_URL

### API Calls Return 404

**Check:**
1. Verify backend URL is correct: `https://s88-app-backend.onrender.com`
2. Verify API endpoint exists (e.g., `/api/projects`)
3. Test backend directly: `curl https://s88-app-backend.onrender.com/api/projects`

### Frontend Shows Old Version

**Solution:**
1. Hard refresh: **Ctrl+Shift+Delete** (Windows) or **Cmd+Shift+Delete** (Mac)
2. Clear browser cache
3. Or wait 24 hours for cache invalidation

## Update Frontend

Every time you push to GitHub main:

1. **Vercel automatically rebuilds**
2. **Takes 2-5 minutes**
3. **Check "Deployments" tab** for status

To manually redeploy:
1. Click "Deployments"
2. Click latest deployment
3. Click "..." → "Redeploy"

## Environment Variable Updates

If you change backend URL:

1. **Click "Settings"** in Vercel
2. **Click "Environment Variables"**
3. **Edit `VITE_API_BASE_URL`**
4. **Click "Save"**
5. **Vercel automatically redeploys**

## Custom Domain (Optional)

To use your own domain:

1. **Click "Settings"**
2. **Click "Domains"**
3. **Add your domain**
4. **Follow DNS setup instructions**

Example: `s88-app.your-domain.com` instead of `vercel.app`

## Performance Monitoring

1. **Click "Analytics"** tab
2. **View deployment metrics**
3. **Monitor Core Web Vitals**

## Next Steps

✅ Frontend deployed on Vercel
✅ Backend deployed on Render
✅ Database connected to Neon

Now:
1. **Invite users** to test: `https://s88-app-frontend.vercel.app`
2. **Keep local development** separate on `localhost`
3. **Collect feedback** from testers

