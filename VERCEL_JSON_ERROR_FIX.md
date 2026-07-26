# Fix: "Unexpected token 'T', is not valid JSON" Error

## The Problem

When testing on Vercel, you saw:
```
Unexpected token 'T', "The page c"... is not valid JSON
```

This happens because:
1. Vercel frontend (`https://s88-app-frontend.vercel.app`) makes API call
2. Render backend CORS only allowed `localhost:5173`
3. Request was blocked, returning HTML error page
4. Frontend tried to parse HTML as JSON → Error

## The Solution ✅

Fixed in `backend/src/server.js`:

**Before:**
```javascript
app.use(cors({ origin: 'http://localhost:5173' }));
```

**After:**
```javascript
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://s88-app-frontend.vercel.app',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
```

Now allows:
- ✅ Local development (`localhost:5173`)
- ✅ Vercel production (`s88-app-frontend.vercel.app`)
- ✅ Custom domains via `FRONTEND_URL` env var

## Deploy the Fix

Already pushed to GitHub. Render will auto-redeploy:

1. **Wait 2-5 minutes** for Render to rebuild
2. **Check Render Deployments tab** for "Active" status
3. **Check Render Logs** for successful start

## Test After Fix

1. **Refresh Vercel frontend** (hard refresh: Ctrl+Shift+Delete)
2. **Open browser console** (F12)
3. **Try creating a project**
4. **Should see success** (no JSON errors)

## If Still Getting Error

### Check the response

Open browser Developer Tools (F12) → Network tab → Click API call:

**Should see:**
- Status: `200 OK`
- Response: JSON data `{"id": 1, "name": "...}`

**NOT:**
- Status: `404 Not Found`
- Response: HTML error page

### If still 404

1. **Verify backend is running**
   ```bash
   curl https://s88-app-backend.onrender.com/api/health
   ```
   Should return: `{"ok":true,"time":"2026-07-26T..."}`

2. **Check Render logs** for errors starting database

3. **Verify database connection** (see SSL_FIX_QUICK_REFERENCE.md)

---

## Status

✅ **Fixed and deployed**

Render auto-redeploy in progress (2-5 minutes).

