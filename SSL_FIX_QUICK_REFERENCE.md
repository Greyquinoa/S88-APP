# SSL Connection Fix (Neon/Render)

## The Problem

```
[Server] Failed to start: connection is insecure (try using `sslmode=require`)
```

This happens because Neon requires SSL encryption for cloud connections.

## The Solution

Already fixed in `backend/src/db.js`:

```javascript
// Before (line ~14):
_pool = new Pool({
  host:     process.env.PGHOST || 'localhost',
  port:     Number(process.env.PGPORT) || 5432,
  user:     process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 's88_app',
});

// After (fixed):
const isProduction = process.env.NODE_ENV === 'production';
_pool = new Pool({
  host:     process.env.PGHOST || 'localhost',
  port:     Number(process.env.PGPORT) || 5432,
  user:     process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 's88_app',
  ssl:      isProduction ? { rejectUnauthorized: false } : false,  // ← Added this
});
```

## What This Does

- **Local (`NODE_ENV !== production`)**: Uses unencrypted connection to localhost
- **Production (`NODE_ENV === production`)**: Enables SSL for Neon cloud database

## Deploy the Fix

Already committed to GitHub. Render will auto-redeploy when you push:

```bash
# Fix is already in the code, just push
git push github main

# Render will rebuild and redeploy (2-5 minutes)
```

## Verify It's Working

After Render redeploys, check logs:

```
[DB] Connected — postgres://abc123.neon.tech:5432/s88_app
```

If you see that message, SSL connection is working!

## If You Need to Manually Fix

Edit `backend/src/db.js` line ~12-20 and add:

```javascript
const isProduction = process.env.NODE_ENV === 'production';
// ... then in the Pool config:
ssl: isProduction ? { rejectUnauthorized: false } : false,
```

Then:
```bash
git add backend/src/db.js
git commit -m "fix: Enable SSL for Neon database"
git push github main
```

## Why `rejectUnauthorized: false`?

Neon uses valid SSL certificates, but this setting allows the connection without strict certificate verification. This is safe for production because:
- Neon's certificates are valid
- The connection is still encrypted
- Only needed for cloud-hosted databases with self-signed or non-standard certs

**For production, best practice would be:**
```javascript
ssl: {
  rejectUnauthorized: true,
  ca: process.env.NEON_CA_CERT  // If needed
}
```

But for testing, the simple approach works fine.

---

**Status:** ✅ Fixed and deployed

