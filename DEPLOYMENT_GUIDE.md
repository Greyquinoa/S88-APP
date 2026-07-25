# Deployment Guide: Local vs. Online Testing

This document outlines how to deploy the S88-APP separately for **local development** and **online testing**, keeping them completely isolated.

## Architecture Overview

```
Local Development (Your Machine)
├── Frontend: React + Vite (localhost:5173)
├── Backend: Node.js/Express (localhost:3001)
└── Database: Local PostgreSQL (localhost:5432)

Online Testing (Cloud)
├── Frontend: React + Vite → Vercel (your-app.vercel.app)
├── Backend: Node.js/Express → Render (your-app.onrender.com)
└── Database: PostgreSQL → Neon (neon.tech)
```

## Prerequisites

Before deploying online, you'll need accounts for:
1. **Vercel** (Frontend hosting) - https://vercel.com
2. **Render** (Backend hosting) - https://render.com
3. **Neon** (PostgreSQL database) - https://neon.tech

## Local Development Setup (Current)

Your local setup requires:
- Node.js + npm
- PostgreSQL installed locally
- Environment file: `backend/.env`

### Running Locally

```bash
# Terminal 1: Start backend
cd backend
npm install
npm run dev
# Backend running on http://localhost:3001

# Terminal 2: Start frontend
cd frontend
npm install
npm run dev
# Frontend running on http://localhost:5173
```

---

## Online Testing Setup (Separate Environment)

### Step 1: Prepare GitHub Repository

Your code is already on GitHub at `https://github.com/Greyquinoa/S88-APP.git`

Ensure the `main` branch has:
- Clean `backend/` folder
- Clean `frontend/` folder
- No local `.env` files committed (they're in `.gitignore`)

---

## Step 2: Database Setup (Neon PostgreSQL)

### Create Neon Project

1. Go to https://neon.tech and sign up
2. Create a new project called **"s88-app-testing"**
3. Note your connection string:
   ```
   postgresql://[user]:[password]@[host]/s88_app
   ```

### Initialize Database Schema

The database schema will auto-initialize when the backend first connects (via `ensureSchema()` in `db.js`).

---

## Step 3: Backend Deployment (Render)

### Create Web Service on Render

1. **Go to https://render.com**
2. **Click "New" → "Web Service"**
3. **Connect your GitHub repository**: `https://github.com/Greyquinoa/S88-APP.git`
4. **Configure the service:**

| Setting | Value |
|---------|-------|
| Name | `s88-app-backend` |
| Environment | `Node` |
| Region | Choose closest to you |
| Build Command | `cd backend && npm install` |
| Start Command | `cd backend && npm start` |
| Auto-Deploy | Yes (deploys on main branch pushes) |

### Set Environment Variables on Render

In the Render dashboard, go to **Environment** and add:

```
PGHOST=your-neon-host.neon.tech
PGPORT=5432
PGUSER=your-neon-user
PGPASSWORD=your-neon-password
PGDATABASE=s88_app
PORT=3001
NODE_ENV=production
```

**Get these values from your Neon project details page.**

### Update CORS in Backend (Optional)

Edit `backend/src/server.js` to allow Vercel frontend:

```javascript
const cors = require('cors');

app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? 'https://your-vercel-domain.vercel.app'
    : 'http://localhost:5173',
  credentials: true
}));
```

**Your backend URL will be:** `https://s88-app-backend.onrender.com`

---

## Step 4: Frontend Deployment (Vercel)

### Deploy to Vercel

1. **Go to https://vercel.com**
2. **Click "Import Project"**
3. **Enter your GitHub URL**: `https://github.com/Greyquinoa/S88-APP.git`
4. **Configure settings:**

| Setting | Value |
|---------|-------|
| Project Name | `s88-app-frontend` |
| Framework | `Vite` |
| Root Directory | `frontend` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm install` |

### Set Environment Variables in Vercel

Create a `.env.production` file in `frontend/` (NOT committed to git):

```
VITE_API_BASE_URL=https://s88-app-backend.onrender.com
```

**Or set in Vercel dashboard Environment Variables:**
```
VITE_API_BASE_URL=https://s88-app-backend.onrender.com
```

### Update Frontend API Calls

Edit `frontend/src/api.js` to use the environment variable:

```javascript
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

export async function fetchProjects() {
  const response = await fetch(`${API_BASE}/api/projects`);
  return response.json();
}

// ... rest of your API calls
```

**Your frontend URL will be:** `https://s88-app-frontend.vercel.app`

---

## Step 5: Verify Deployment

### Test the Online App

1. **Frontend:** Open `https://s88-app-frontend.vercel.app`
2. **Check browser console** for any CORS errors
3. **Test API calls:** Try creating a project, importing data, etc.

### Monitor Backend Logs

On Render dashboard:
- Go to your `s88-app-backend` service
- Click **"Logs"** tab
- Watch for connection success or errors

### Monitor Frontend Deployment

On Vercel dashboard:
- Click your project
- View **"Deployments"** tab
- Click latest deployment → **"Logs"**

---

## Step 6: Keep Separation Clean

### Local Development Rules

**DO NOT:**
- Commit `.env` files to git
- Use online database URLs in local development
- Connect local app to online services

**DO:**
- Keep `backend/.env` with `localhost` settings
- Use local PostgreSQL for testing
- Use `localhost:3001` and `localhost:5173`

### Online Testing Rules

**Environment on Render/Vercel must include:**
- `PGHOST`: Neon hostname (NOT localhost)
- `PGPORT`: 5432
- `NODE_ENV=production`
- Vercel frontend URL in CORS

**NO local files should contain production credentials**

---

## Deployment Workflow

### When You Want to Test Online Changes

1. **Commit and push to GitHub main branch**
   ```bash
   git add .
   git commit -m "feat: new feature for testing"
   git push github main
   ```

2. **Render auto-deploys backend** (5-10 minutes)
3. **Vercel auto-deploys frontend** (2-5 minutes)
4. **Test at:** https://s88-app-frontend.vercel.app

### When You Want to Development Locally

1. **Make changes locally**
2. **Test with `npm run dev`** (no git needed)
3. **Only commit when ready to test online**

---

## Troubleshooting

### Backend Can't Connect to Neon Database

**Error:** `ECONNREFUSED` or `ENOTFOUND`

**Solution:**
1. Verify Neon credentials in Render environment
2. Check Neon project is running (not paused)
3. Test connection locally first with Neon credentials
4. Whitelist Render IP in Neon firewall (if needed)

### Frontend CORS Errors

**Error:** `Access to XMLHttpRequest blocked by CORS`

**Solution:**
1. Verify `VITE_API_BASE_URL` is set correctly
2. Check backend CORS config includes Vercel domain
3. Verify API endpoint path is correct

### Database Schema Issues

**The app auto-creates the schema** via `ensureSchema()` on first run.

If you need to reset the online database:
1. Go to Neon dashboard
2. Drop and recreate the database
3. Redeploy backend (will auto-init schema)

---

## Database Backups

### Backup Local Database

```bash
pg_dump -U postgres s88_app > s88_app_backup.sql
```

### Restore Local Database

```bash
psql -U postgres s88_app < s88_app_backup.sql
```

### Backup Neon Database

Use Neon's built-in backup feature in dashboard → Database → Backups

---

## Monitoring & Maintenance

### Check Backend Health

```bash
curl https://s88-app-backend.onrender.com/health
# (Add a /health endpoint in backend/src/server.js if not present)
```

### View Backend Logs

- Render Dashboard → Service → Logs

### View Frontend Logs

- Vercel Dashboard → Project → Deployments → Logs

### Monitor Database Usage

- Neon Dashboard → Branches → Storage & CPU usage

---

## Cost Considerations

| Service | Free Tier | Notes |
|---------|-----------|-------|
| **Vercel** | 10GB bandwidth/month | Includes preview deployments |
| **Render** | $7/month (sleeping) | Free tier spins down after 15 min inactivity |
| **Neon** | $0 serverless compute + 3GB storage | Scales to $0.5 per 1GB extra |

---

## Next Steps

1. ✅ Create accounts on Vercel, Render, Neon
2. ✅ Set up Neon PostgreSQL database
3. ✅ Deploy backend to Render
4. ✅ Deploy frontend to Vercel
5. ✅ Test the online app at Vercel URL
6. ✅ Invite users to test at online URL
7. ✅ Collect feedback without affecting local development

---

## Support

- **Vercel Docs:** https://vercel.com/docs
- **Render Docs:** https://render.com/docs
- **Neon Docs:** https://neon.tech/docs

