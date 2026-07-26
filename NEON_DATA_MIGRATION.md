# Migrate Data from Local PostgreSQL to Neon

Guide to copy all tables and data from your local database to Neon cloud database.

## Prerequisites

- ✅ Local PostgreSQL running with data in `s88_app` database
- ✅ Neon account with database created (see NEON_SETUP.md)
- ✅ Neon connection credentials

## Step 1: Fix SSL Connection Issue (Render)

The error `connection is insecure (try using 'sslmode=require')` is fixed in `backend/src/db.js`:

```javascript
ssl: isProduction ? { rejectUnauthorized: false } : false,
```

**Commit and push this fix:**

```bash
git add backend/src/db.js
git commit -m "fix: Enable SSL for Neon production database"
git push github main
```

Render will auto-redeploy in 2-5 minutes.

---

## Step 2: Get Neon Connection Details

1. **Go to https://neon.tech dashboard**
2. **Click your project**
3. **Click "Connection String"**
4. **Select "Connection parameters"**
5. **Copy each value:**

```
Host:     [abc123].neon.tech
Port:     5432
User:     [your-user]
Password: [your-password]
Database: s88_app
```

---

## Step 3: Run Data Migration

### Option A: From Your Local Machine (Recommended)

```bash
# Navigate to backend folder
cd backend

# Run migration script with Neon credentials:
NEON_HOST=abc123.neon.tech \
NEON_USER=your-user \
NEON_PASSWORD=your-password \
NEON_DATABASE=s88_app \
node migrate-data.js
```

**On Windows (PowerShell):**

```powershell
$env:NEON_HOST = "abc123.neon.tech"
$env:NEON_USER = "your-user"
$env:NEON_PASSWORD = "your-password"
$env:NEON_DATABASE = "s88_app"
node migrate-data.js
```

**On Windows (Command Prompt):**

```cmd
set NEON_HOST=abc123.neon.tech
set NEON_USER=your-user
set NEON_PASSWORD=your-password
set NEON_DATABASE=s88_app
node migrate-data.js
```

### What You'll See

```
[Migration] Starting data migration...

[Migration] Connecting to source (local): localhost:5432
[Migration] ✓ Connected to source

[Migration] Connecting to target (Neon): abc123.neon.tech
[Migration] ✓ Connected to target

[Migration] Fetching table list...
[Migration] Found 42 tables

[Migration] Disabled foreign key checks on target

[Migration] ✓ lib_cm_types: 5 rows copied
[Migration] ✓ lib_blocks: 15 rows copied
[Migration] ✓ projects: 2 rows copied
... (and more tables)

[Migration] Re-enabled foreign key checks

[Migration] ✓ Migration complete!
[Migration] Total rows migrated: 342
```

---

## Step 4: Verify Migration

### Option 1: Check via psql

```bash
# Connect to Neon
psql -h abc123.neon.tech -U your-user -d s88_app -W

# List tables
\dt

# Count rows in a table
SELECT COUNT(*) FROM projects;

# Exit
\q
```

### Option 2: Check via Neon Dashboard

1. **Go to neon.tech dashboard**
2. **Click your project**
3. **Click "SQL Editor"**
4. **Run:**
   ```sql
   SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
   ```

Should show all your tables.

### Option 3: Test with Backend

Once migration is done and SSL fix is deployed:

1. **Wait for Render redeploy** (2-5 minutes)
2. **Check Render logs:**
   ```
   [DB] Connected — postgres://abc123.neon.tech:5432/s88_app
   ```

If you see that, your backend is successfully connected to Neon!

---

## Step 5: Verify All Your Data Made It

Check critical tables in Neon:

```sql
-- Count total rows by table
SELECT 
  schemaname,
  tablename,
  n_live_tup as row_count
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;
```

Should show similar counts to your local database.

---

## Troubleshooting

### Migration Script Fails: "Connection refused"

**Problem:** Can't connect to local database

**Solution:**
1. Verify PostgreSQL is running
2. Check credentials in `backend/.env`
3. Test with: `psql -h localhost -U postgres -d s88_app`

### Migration Script Fails: "Authentication failed"

**Problem:** Wrong Neon credentials

**Solution:**
1. Double-check Neon password (copy-paste carefully)
2. Verify username and host
3. Test with: `psql -h [host].neon.tech -U [user] -d s88_app`

### Migration Script Fails: "Too many connections"

**Problem:** Neon free tier has connection limits

**Solution:**
1. Wait a minute and retry
2. Or upgrade to Neon paid tier for more connections

### Some Tables Didn't Copy

**Problem:** Foreign key constraints prevented insert

**Solution:** Script disables foreign keys during migration. If still issues:
1. Check Neon logs for specific table errors
2. Manually copy that table via SQL dump:
   ```bash
   # Dump one table from local
   pg_dump -h localhost -U postgres -d s88_app -t table_name > table.sql
   
   # Restore to Neon
   psql -h abc123.neon.tech -U user -d s88_app < table.sql
   ```

### Data Looks Incomplete

**Verify counts match:**

Local:
```bash
psql -h localhost -U postgres -d s88_app -c "SELECT COUNT(*) FROM projects;"
```

Neon:
```bash
psql -h abc123.neon.tech -U user -d s88_app -c "SELECT COUNT(*) FROM projects;"
```

Should be the same number.

---

## How It Works

The migration script:

1. **Connects to local PostgreSQL**
   - Gets all table names
   - Reads all rows from each table

2. **Connects to Neon**
   - Disables foreign key checks (for clean insert)
   - Truncates each table (clears old data)
   - Inserts all rows in batches

3. **Re-enables foreign keys**
   - Ensures data integrity going forward

4. **Reports results**
   - Shows how many rows per table
   - Total rows migrated

---

## After Migration

### Keep in Sync

**Local changes** now affect only local database.
**Neon changes** only affect online users.

They're separate! That's the point.

### If You Need to Reset Neon

Option 1: **Re-run migration** (overwrites everything)
```bash
NEON_HOST=... NEON_USER=... NEON_PASSWORD=... node migrate-data.js
```

Option 2: **Via Neon Dashboard**
1. Go to dashboard
2. Delete database
3. Create new `s88_app` database
4. Run migration again

Option 3: **Start fresh online**
- Delete all tables in Neon
- Backend will auto-create schema on next deploy
- Online app starts with empty database

---

## What If Migration Fails?

### Full Error Log

Run with detailed logging:
```bash
# Add DEBUG output
DEBUG=* node migrate-data.js
```

### Manual Migration via SQL Dump

```bash
# Export from local
pg_dump -h localhost -U postgres s88_app > backup.sql

# Import to Neon
psql -h abc123.neon.tech -U user -d s88_app < backup.sql
```

### Ask for Help

Include in your message:
- Migration error output
- Neon connection test result
- Local PostgreSQL version: `psql --version`

---

## Recap

1. ✅ Fix SSL in `backend/src/db.js`
2. ✅ Push to GitHub
3. ✅ Get Neon credentials
4. ✅ Run migration script
5. ✅ Verify in Neon Dashboard
6. ✅ Wait for Render redeploy
7. ✅ Check Render logs for connection success

**Done!** Your online app now has your local data.

