# S88-APP Deployment Guide

**Deploy your app online while keeping local development completely separate.**

## 📖 Documentation Map

```
📦 S88-APP Repository
│
├─ 📄 ONLINE_DEPLOYMENT_SUMMARY.md   ← START HERE (Overview)
│  └─ Read this first for quick understanding
│
├─ 📋 DEPLOYMENT_CHECKLIST.md        ← Step-by-step checklist
│  └─ Follow phases 1-10 to deploy
│
├─ 📚 Detailed Guides (Pick what you need):
│  ├─ NEON_SETUP.md                 (PostgreSQL database)
│  ├─ RENDER_SETUP.md               (Node.js backend)
│  ├─ VERCEL_SETUP.md               (React frontend)
│  └─ DEPLOYMENT_GUIDE.md           (Full architecture)
│
└─ ⚙️  Configuration Files:
   ├─ backend/.env                  (Local - NOT on git)
   ├─ backend/.env.example          (Example for local)
   ├─ backend/.env.production.example (Example for production)
   ├─ frontend/.env                 (Local - NOT on git)
   └─ frontend/.env.example         (Example template)
```

## 🎯 Choose Your Path

### 🏠 If You're Just Starting Local Development

**You don't need to do anything!** Your app already runs locally:

```bash
# Terminal 1: Start backend
cd backend && npm run dev
# Backend at http://localhost:3001

# Terminal 2: Start frontend
cd frontend && npm run dev
# Frontend at http://localhost:5173
```

→ Continue developing locally. Come back to this guide when you want to deploy.

---

### 🚀 If You Want to Deploy Online

**Follow these steps:**

#### 1️⃣ **Read the Overview** (5 minutes)
Open: [`ONLINE_DEPLOYMENT_SUMMARY.md`](ONLINE_DEPLOYMENT_SUMMARY.md)
- Understand the architecture
- See the benefits
- Learn the workflow

#### 2️⃣ **Create Cloud Accounts** (5 minutes)
Sign up for free on:
- **Vercel:** https://vercel.com
- **Render:** https://render.com
- **Neon:** https://neon.tech

#### 3️⃣ **Follow the Checklist** (45 minutes)
Open: [`DEPLOYMENT_CHECKLIST.md`](DEPLOYMENT_CHECKLIST.md)

Follow each phase sequentially:
1. Prepare
2. Create accounts ✓ (done above)
3. Set up Neon database
4. Deploy backend to Render
5. Update CORS
6. Deploy frontend to Vercel
7. Test online
8. Verify separation
9. Learn workflow
10. Invite users

#### 4️⃣ **Reference Detailed Guides When Stuck**

| If you need help with... | Read this... |
|--------------------------|---|
| Database connection | [`NEON_SETUP.md`](NEON_SETUP.md) |
| Backend deployment | [`RENDER_SETUP.md`](RENDER_SETUP.md) |
| Frontend deployment | [`VERCEL_SETUP.md`](VERCEL_SETUP.md) |
| Full architecture | [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) |

---

## 🏗️ Architecture

### Local (Your Machine)
```
Frontend: http://localhost:5173
Backend:  http://localhost:3001
Database: localhost:5432 (PostgreSQL)

Development only - No online impact
```

### Online (Cloud)
```
Frontend: https://s88-app-frontend.vercel.app
Backend:  https://s88-app-backend.onrender.com
Database: Neon PostgreSQL (cloud)

Users test here - No local impact
```

**Key:** They're completely separate and independent!

---

## ⚡ Quick Reference

### Environment Variables

| Variable | Local | Production |
|----------|-------|------------|
| `PGHOST` | localhost | neon.tech host |
| `PGPORT` | 5432 | 5432 |
| `PGDATABASE` | s88_app | s88_app |
| `NODE_ENV` | development | production |
| `VITE_API_BASE_URL` | http://localhost:3001 | https://onrender.com |

### Files to Know

| File | Purpose | Committed? |
|------|---------|-----------|
| `backend/.env` | Local configuration | ❌ NO (git-ignored) |
| `backend/.env.example` | Local template | ✅ YES |
| `backend/.env.production.example` | Production template | ✅ YES |
| `frontend/.env` | Frontend config | ❌ NO (git-ignored) |
| `frontend/.env.example` | Frontend template | ✅ YES |

**Rule:** Never commit actual `.env` files with real credentials!

---

## 🔄 Typical Workflow

### Developing

```bash
# 1. Make changes locally
# 2. Test with npm run dev
# 3. When ready, commit and push:
git add .
git commit -m "feat: your change"
git push github main
```

### Deploying

```
# Automatic! Render & Vercel auto-deploy on push
1. Render rebuilds backend (2-5 min)
2. Vercel rebuilds frontend (2-5 min)
3. Check dashboards for status
```

### Testing Online

```
Open: https://s88-app-frontend.vercel.app
Invite users to test
Collect feedback
```

### Fixing Issues

```bash
# If something breaks online:
1. Fix locally (npm run dev)
2. Test the fix locally
3. Commit and push
4. Services auto-redeploy
```

---

## 🆘 Troubleshooting Quick Links

| Problem | Solution |
|---------|----------|
| "Can't connect to database" | See NEON_SETUP.md → Troubleshooting |
| "Backend won't start on Render" | See RENDER_SETUP.md → Troubleshooting |
| "CORS errors in browser" | See VERCEL_SETUP.md → Troubleshooting |
| "Frontend shows old version" | See VERCEL_SETUP.md → Build Fails |
| "Need to reset database" | See NEON_SETUP.md → Resetting Database |

---

## 📊 Status Overview

### Services

| Service | Status | Cost |
|---------|--------|------|
| **Vercel (Frontend)** | ⬜ Not set up yet | Free tier available |
| **Render (Backend)** | ⬜ Not set up yet | Free tier available |
| **Neon (Database)** | ⬜ Not set up yet | Free tier (3GB) |
| **GitHub (Code)** | ✅ Ready | Free |

### Documentation

| Document | Status |
|----------|--------|
| ONLINE_DEPLOYMENT_SUMMARY.md | ✅ Complete |
| DEPLOYMENT_CHECKLIST.md | ✅ Complete |
| NEON_SETUP.md | ✅ Complete |
| RENDER_SETUP.md | ✅ Complete |
| VERCEL_SETUP.md | ✅ Complete |
| DEPLOYMENT_GUIDE.md | ✅ Complete |

---

## 🎓 Learning Resources

- **Vercel:** https://vercel.com/docs
- **Render:** https://render.com/docs
- **Neon:** https://neon.tech/docs
- **GitHub:** https://docs.github.com

---

## ✅ Success Checklist

By the end you'll have:

- [ ] ✅ Local app running on `localhost`
- [ ] ✅ Online database on Neon
- [ ] ✅ Backend deployed on Render
- [ ] ✅ Frontend deployed on Vercel
- [ ] ✅ Auto-deployment on every GitHub push
- [ ] ✅ Complete separation (local vs online)
- [ ] ✅ Users testing online URL
- [ ] ✅ Continuous local development

---

## 🚀 Get Started Now

**Next step:** Open [`ONLINE_DEPLOYMENT_SUMMARY.md`](ONLINE_DEPLOYMENT_SUMMARY.md)

Takes 5 minutes to read, then 45 minutes to deploy!

---

## 💬 Questions?

Each guide has:
- Step-by-step instructions
- Screenshots/examples
- Troubleshooting sections
- Command snippets

**Everything you need is in the docs above!** 📚

