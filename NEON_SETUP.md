# Neon PostgreSQL Database Setup

Complete guide to set up PostgreSQL on Neon for online testing.

## Overview

Neon provides **serverless PostgreSQL** with automatic backups and scaling. Perfect for testing environments.

## Prerequisites

- ✅ Neon account (https://neon.tech, free to start)
- ✅ No credit card required for free tier

## Step 1: Create Neon Project

1. **Go to https://neon.tech**
2. **Click "Sign Up"** (or log in)
3. **Click "Create a project"**
4. **Fill in:**
   - **Name:** `s88-app-testing`
   - **Database name:** `s88_app`
   - **Region:** Choose closest to your users
5. **Click "Create project"**

## Step 2: Get Connection Credentials

### Find Your Connection String

1. **On Neon dashboard**, click your project
2. **Click "Connection String"** tab
3. **Select "Connection parameters"** (not "Connection string")
4. **You'll see:**

```
Host: [host].neon.tech
Port: 5432
User: [user]
Password: [password]
Database: s88_app
```

### Copy Each Value

Save these somewhere safe (e.g., password manager):

```
PGHOST = [host].neon.tech
PGPORT = 5432
PGUSER = [user]
PGPASSWORD = [password]
PGDATABASE = s88_app
```

## Step 3: Test Connection Locally (Optional)

Before deploying online, test that you can connect:

```bash
# On your local machine:
psql -h [host].neon.tech -U [user] -d s88_app -W

# When prompted, enter your password
```

If successful, you'll see:
```
s88_app=>
```

Type `\q` to exit.

## Step 4: Use These Credentials for Deployment

### For Render Backend

1. **Go to Render dashboard**
2. **Click your backend service**
3. **Click "Environment"**
4. **Set these variables:**

```
PGHOST = [your-neon-host].neon.tech
PGPORT = 5432
PGUSER = [your-neon-user]
PGPASSWORD = [your-neon-password]
PGDATABASE = s88_app
```

5. **Click "Save"**
6. **Service auto-redeploys** (2-5 minutes)

## Step 5: Verify Database Setup

### Option 1: Via Logs

In Render dashboard:
1. **Click backend service**
2. **Click "Logs"**
3. **Look for:**
   ```
   [DB] Connected — postgres://...
   ```

### Option 2: Via psql (Local)

```bash
psql -h [host].neon.tech -U [user] -d s88_app -W
\dt  # Lists all tables
\q   # Exit
```

Should show tables like:
```
lib_cm_types
lib_blocks
projects
project_instances
hw_imports
io_imports
... and more
```

### Option 3: Via Neon Dashboard

1. **Go to neon.tech dashboard**
2. **Click your project**
3. **Click "SQL Editor"**
4. **Run:**
   ```sql
   SELECT * FROM information_schema.tables WHERE table_schema = 'public';
   ```

Should return your tables.

## Database Features

### Auto-Initialization

The app automatically creates the **entire schema** on first run:
- All tables
- All indexes
- All migrations
- Seed data (valve commands, hardware templates, etc.)

**No manual SQL needed!**

### Backups

Neon automatically backs up your database. View in dashboard:
1. **Click your project**
2. **Click "Backups"** tab
3. **See automatic daily backups**

### Branching (Advanced)

Neon supports branching for testing schema changes:
1. **Click "Branches"** tab
2. **Create a dev branch**
3. **Test schema changes** without affecting production data

### Monitoring

Monitor usage in dashboard:
1. **Click "Monitor"** tab
2. **See storage, compute, and connections**
3. **Free tier includes generous limits**

## Resetting the Database

If you need a fresh start:

### Option 1: Via Neon Dashboard (Recommended)

1. **Go to Neon dashboard**
2. **Click your project**
3. **Click "Settings"**
4. **Click "Delete database"**
5. **Confirm deletion**
6. **Create new database** with same name

The backend will auto-initialize the schema again on next deploy.

### Option 2: Via psql

```bash
# Connect to database
psql -h [host].neon.tech -U [user] -d s88_app -W

# Drop all tables (dangerous!)
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO PUBLIC;

# Disconnect
\q

# Redeploy backend on Render to reinit schema
```

## Backups & Exports

### Backup Your Data

```bash
# Dump entire database
pg_dump -h [host].neon.tech -U [user] -d s88_app > backup.sql

# When prompted, enter your password
```

### Restore to Local Postgres

```bash
# Create local database
createdb s88_app_backup

# Restore dump
psql s88_app_backup < backup.sql
```

## Common Issues

### "Too Many Connections"

**Error in logs:**
```
FATAL: too many connections for role "[user]"
```

**Solution:**
1. Neon free tier allows 25 concurrent connections
2. Verify Render is not creating too many connections
3. Add connection pooling in backend (optional)

### "Authentication Failed"

**Error:**
```
FATAL: password authentication failed for user "[user]"
```

**Solution:**
1. Double-check password is exactly correct
2. Check for typos in PGPASSWORD
3. Regenerate password in Neon dashboard if needed

### "Host Unknown"

**Error:**
```
could not translate host name "[host].neon.tech" to address
```

**Solution:**
1. Verify hostname is spelled correctly
2. Check internet connection
3. Verify Neon project is active (not paused)

## Free Tier Limits

| Resource | Limit |
|----------|-------|
| **Storage** | 3 GB |
| **Compute** | Serverless (scales to $0) |
| **Connections** | 25 concurrent |
| **Connections/hour** | 1000 |
| **Backups** | Automatic daily |

For more storage, upgrade to paid ($0.5 per GB).

## Next Steps

✅ Neon database created
✅ Credentials saved

Now:
1. **Set up Render backend** (RENDER_SETUP.md)
2. **Deploy frontend to Vercel** (VERCEL_SETUP.md)
3. **Test online app**

