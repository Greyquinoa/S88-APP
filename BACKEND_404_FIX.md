# Fix: Backend 404 Errors (Server Not Responding)

## The Problem

All API endpoints return 404:
```
GET /api/projects → 404 Not Found
GET /api/unit-types → 404 Not Found
GET /api/health → 404 Not Found
```

This means the Express server **never started** - it crashed during initialization.

## Most Likely Cause

**Database connection failed during startup**

The server tries to:
1. Connect to PostgreSQL
2. Initialize schema

If either fails, the whole server crashes and Render returns 404 for all routes.

---

## How To Debug Locally

### Step 1: Run Diagnostic Script

```bash
cd backend

# Set your Neon credentials
NODE_ENV=production \
PGHOST=your-host.neon.tech \
PGUSER=your-user \
PGPASSWORD=your-pass \
PGDATABASE=s88_app \
node diagnose-db.js
```

This will tell you:
- ✅ If database connection works
- ✅ If schema is initialized
- ✅ How many tables exist
- ❌ If connection fails, why it failed

### Step 2: Understand the Output

**If successful:**
```
[Diagnosis] ✅ Connection successful
[Diagnosis] ✅ Found 42 tables
[Diagnosis] ✅ ALL CHECKS PASSED
```

**If database not found:**
```
[Diagnosis] ❌ Connection failed
[Diagnosis] → Database does not exist
```

**If authentication failed:**
```
[Diagnosis] ❌ Connection failed
[Diagnosis] → Authentication failed
[Diagnosis] → Check PGUSER and PGPASSWORD
```

**If host is wrong:**
```
[Diagnosis] ❌ Connection failed
[Diagnosis] → Database is not running or host is wrong
```

---

## Common Issues & Fixes

### Issue 1: Wrong Neon Credentials in Render

**Symptom:**
```
[Diagnosis] → Authentication failed
```

**Fix:**
1. Go to Neon dashboard
2. Copy your connection string exactly
3. Go to Render dashboard → Your service → Environment
4. Update these variables:
   ```
   PGHOST = [your-exact-host]
   PGPORT = 5432
   PGUSER = [your-exact-user]
   PGPASSWORD = [your-exact-password]
   PGDATABASE = s88_app
   ```
5. Click "Save" (Render auto-redeploys)
6. Wait 2-5 minutes for redeploy

### Issue 2: Database Doesn't Exist on Neon

**Symptom:**
```
[Diagnosis] → Database does not exist
```

**Fix:**
1. Go to Neon dashboard
2. Click your project
3. Verify database `s88_app` exists
4. If not, create it:
   - Click "New Database"
   - Name: `s88_app`
   - Click "Create"
5. Run diagnostic again

### Issue 3: Neon Database is Paused

**Symptom:**
```
[Diagnosis] → Database is not running
```

**Fix:**
1. Go to Neon dashboard
2. Click your project
3. Check if it shows "Paused"
4. If paused, click "Resume"
5. Wait for status to change to "Available"
6. Run diagnostic again

### Issue 4: NODE_ENV Not Set

**Symptom:**
```
SSL connection error or insecure connection
```

**Fix:**
In Render Environment, make sure `NODE_ENV=production` is set:
1. Click your service → Environment
2. Verify `NODE_ENV` variable exists
3. If not, add it:
   ```
   NODE_ENV = production
   ```
4. Click "Save"
5. Wait 2-5 minutes for redeploy

### Issue 5: Schema Initialization Fails

**Symptom:**
```
[Diagnosis] ✅ Connection successful
[Diagnosis] ❌ No tables found
[Server] Failed to start
```

**Fix:**
This can happen if database was reset. The backend auto-initializes on next startup:
1. Check database connection works (diagnostic)
2. Redeploy backend:
   - Render dashboard → Service → Manual Deploy
   - Click "Deploy latest commit"
3. Check logs for schema creation

---

## Step-by-Step Debugging

### 1. Test Local Connection

```bash
# Can you connect to Neon locally?
psql -h your-host.neon.tech -U your-user -d s88_app -W
\dt  # List tables
\q  # Quit
```

### 2. Run Diagnostic

```bash
NODE_ENV=production \
PGHOST=your-host.neon.tech \
PGUSER=your-user \
PGPASSWORD=your-pass \
PGDATABASE=s88_app \
node backend/diagnose-db.js
```

### 3. Start Backend Locally

```bash
# Terminal 1
npm run dev

# Should see:
# [Server] Starting backend server...
# [DB] Connected — postgres://...
# [Server] PCS7 Generator backend → http://localhost:3001
```

### 4. Test Local API

```bash
# Terminal 2
curl http://localhost:3001/api/health
# Should return: {"ok":true,"time":"..."}
```

### 5. If Local Works, Fix Render

If the backend works locally but not on Render:

1. **Check Render environment variables:**
   - All PGHOST, PGUSER, PGPASSWORD, etc. are set
   - NODE_ENV=production

2. **Check Render logs:**
   - Service → Logs
   - Look for connection errors
   - Copy exact error message

3. **Redeploy:**
   - Deployments → Manual Deploy → Deploy latest commit

---

## After Fixing

Once diagnostic shows ✅:

1. **Verify backend is running:**
   ```bash
   curl https://s88-app-backend.onrender.com/api/health
   # Should return: {"ok":true,"time":"..."}
   ```

2. **Refresh Vercel frontend:**
   - Hard refresh: Ctrl+Shift+Delete
   - Should load without JSON errors

3. **Try creating a project:**
   - Should work without 404 errors

---

## Scripts

### Run Diagnostic
```bash
cd backend
NODE_ENV=production \
PGHOST=your-host.neon.tech \
PGUSER=your-user \
PGPASSWORD=your-pass \
node diagnose-db.js
```

### Start Backend Locally
```bash
cd backend
npm run dev
```

### Test API Locally
```bash
curl http://localhost:3001/api/health
curl http://localhost:3001/api/projects
```

---

## Checklist

- [ ] Diagnostic script runs and shows ✅
- [ ] Render environment variables are correct
- [ ] NODE_ENV=production is set
- [ ] Neon database is "Available" (not paused)
- [ ] Backend logs show `[DB] Connected`
- [ ] `/api/health` returns 200 with JSON
- [ ] Vercel frontend loads without errors

---

## Still Not Working?

1. **Collect information:**
   - Render logs (copy the startup error)
   - Diagnostic output
   - Environment variables (don't share passwords!)

2. **Check deployment docs:**
   - RENDER_SETUP.md - Backend setup guide
   - NEON_SETUP.md - Database setup guide
   - DEPLOYMENT_GUIDE.md - Full architecture

3. **Common mistakes:**
   - Typo in PGHOST (most common!)
   - Copy-pasted password with extra spaces
   - NODE_ENV not set to "production"
   - Database paused on Neon

