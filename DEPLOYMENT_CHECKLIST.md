# Deployment Checklist: Local → Online Testing

Use this checklist to deploy your app to Vercel, Render, and Neon.

---

## 🟢 Phase 1: Prepare (5 minutes)

- [ ] Code is committed and pushed to GitHub `main` branch
- [ ] Local `.env` file is in `.gitignore` (NOT committed)
- [ ] `backend/.env` and `frontend/.env` are local-only (NOT on git)
- [ ] Verify local app runs: `npm run dev` (both backend and frontend)

**Command:**
```bash
git status  # Should show no .env files
```

---

## 🟡 Phase 2: Create Cloud Accounts (5 minutes)

- [ ] Vercel account created (https://vercel.com)
- [ ] Render account created (https://render.com)
- [ ] Neon account created (https://neon.tech)

---

## 🔵 Phase 3: Neon PostgreSQL (10 minutes)

Follow [NEON_SETUP.md](NEON_SETUP.md)

- [ ] Neon project created: `s88-app-testing`
- [ ] Database name: `s88_app`
- [ ] Connection credentials obtained:
  - [ ] PGHOST: `[host].neon.tech`
  - [ ] PGPORT: `5432`
  - [ ] PGUSER: `[username]`
  - [ ] PGPASSWORD: `[password]`
  - [ ] PGDATABASE: `s88_app`
- [ ] Test connection locally (optional): `psql -h [host] -U [user] -d s88_app`

**Save these credentials securely!**

---

## 🟣 Phase 4: Deploy Backend to Render (15 minutes)

Follow [RENDER_SETUP.md](RENDER_SETUP.md)

- [ ] Render Web Service created: `s88-app-backend`
- [ ] GitHub repository connected
- [ ] Build command set: `cd backend && npm install`
- [ ] Start command set: `cd backend && npm start`
- [ ] Environment variables added in Render:
  ```
  PGHOST=[your-neon-host].neon.tech
  PGPORT=5432
  PGUSER=[your-neon-user]
  PGPASSWORD=[your-neon-password]
  PGDATABASE=s88_app
  NODE_ENV=production
  PORT=3001
  ```
- [ ] Service deployed successfully
- [ ] Backend URL obtained: `https://s88-app-backend.onrender.com`
- [ ] Logs checked for database connection success:
  ```
  [DB] Connected — postgres://...
  ```

---

## 🔴 Phase 5: Update Backend CORS (5 minutes)

- [ ] Edit `backend/src/server.js` CORS whitelist
- [ ] Add Vercel frontend domain:
  ```javascript
  origin: [
    'http://localhost:5173',  // local dev
    'https://s88-app-frontend.vercel.app'  // production
  ]
  ```
- [ ] Commit and push to GitHub
- [ ] Wait for Render auto-redeploy (2-5 minutes)
- [ ] Verify logs show no CORS errors

---

## 🟠 Phase 6: Deploy Frontend to Vercel (15 minutes)

Follow [VERCEL_SETUP.md](VERCEL_SETUP.md)

- [ ] Vercel project created: `s88-app-frontend`
- [ ] GitHub repository connected
- [ ] Root directory set to: `frontend`
- [ ] Framework detected as: `Vite`
- [ ] Environment variable added:
  ```
  VITE_API_BASE_URL = https://s88-app-backend.onrender.com
  ```
- [ ] Project deployed successfully
- [ ] Frontend URL obtained: `https://s88-app-frontend.vercel.app`
- [ ] Deployment logs checked for build success

---

## 🟢 Phase 7: Test Online App (10 minutes)

- [ ] Open frontend URL: `https://s88-app-frontend.vercel.app`
- [ ] Page loads without errors
- [ ] Browser console open (F12) → no CORS errors
- [ ] Test API call:
  ```javascript
  // In console:
  fetch(import.meta.env.VITE_API_BASE_URL + '/api/projects')
    .then(r => r.json())
    .then(d => console.log(d))
  ```
- [ ] API responds with data (empty array is OK)
- [ ] Try basic feature (create project, import data)
- [ ] Check logs for errors:
  - [ ] Vercel → Deployments → Logs
  - [ ] Render → Logs

---

## 📋 Phase 8: Verify Separation (5 minutes)

**Local Development:**
- [ ] Open `http://localhost:5173` (frontend)
- [ ] Backend running on `http://localhost:3001`
- [ ] Using local PostgreSQL (`localhost:5432`)
- [ ] `.env` file has local credentials
- [ ] **No online app affected by local changes**

**Online Testing:**
- [ ] Open `https://s88-app-frontend.vercel.app` (frontend)
- [ ] Backend running on `https://s88-app-backend.onrender.com`
- [ ] Using Neon PostgreSQL (cloud)
- [ ] **No local development affected by online changes**

---

## 🔄 Phase 9: Deploy Workflow (Ongoing)

When you want to **test changes online:**

1. **Make changes locally**
   ```bash
   # Edit files locally and test with npm run dev
   ```

2. **Commit and push to GitHub**
   ```bash
   git add .
   git commit -m "feat: your change description"
   git push github main
   ```

3. **Auto-deployment happens**
   - [ ] Render auto-rebuilds backend (2-5 minutes)
   - [ ] Vercel auto-rebuilds frontend (2-5 minutes)
   - [ ] Check deployments in dashboard

4. **Test online**
   - [ ] Open `https://s88-app-frontend.vercel.app`
   - [ ] Verify changes are live
   - [ ] Collect user feedback

---

## ✅ Phase 10: Invite Users for Testing

- [ ] Share URL: `https://s88-app-frontend.vercel.app`
- [ ] Create testing instructions document
- [ ] Set up feedback collection (email, form, etc.)
- [ ] Monitor Render/Vercel logs for errors
- [ ] Keep local development completely separate

---

## 🚨 Troubleshooting Quick Links

| Issue | Guide |
|-------|-------|
| Database connection fails | NEON_SETUP.md → Troubleshooting |
| Backend won't start | RENDER_SETUP.md → Troubleshooting |
| CORS errors | VERCEL_SETUP.md → Troubleshooting |
| API calls fail | DEPLOYMENT_GUIDE.md → Troubleshooting |

---

## 📞 Support & Documentation

- **Vercel:** https://vercel.com/docs
- **Render:** https://render.com/docs
- **Neon:** https://neon.tech/docs

---

## Summary

| Service | URL | Status |
|---------|-----|--------|
| **Frontend** | https://s88-app-frontend.vercel.app | ✅ Live |
| **Backend** | https://s88-app-backend.onrender.com | ✅ Live |
| **Database** | Neon (s88_app) | ✅ Connected |

**Local development** remains unaffected and separate.

