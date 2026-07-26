#!/usr/bin/env node
/**
 * Database Diagnostic Script
 *
 * Checks if database connection is working
 * Run locally with your Neon credentials to debug connection issues
 *
 * Usage:
 *   node diagnose-db.js
 *
 * Set environment variables:
 *   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
 */

const { Pool } = require('pg');

async function diagnose() {
  console.log('\n[Diagnosis] Starting database connection test...\n');

  const config = {
    host:     process.env.PGHOST || 'localhost',
    port:     Number(process.env.PGPORT) || 5432,
    user:     process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 's88_app',
    ssl:      process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  };

  console.log('[Diagnosis] Configuration:');
  console.log(`  Host:     ${config.host}`);
  console.log(`  Port:     ${config.port}`);
  console.log(`  User:     ${config.user}`);
  console.log(`  Database: ${config.database}`);
  console.log(`  SSL:      ${config.ssl ? 'enabled' : 'disabled'}`);
  console.log(`  Env:      ${process.env.NODE_ENV || 'development'}\n`);

  let pool;
  try {
    console.log('[Diagnosis] Attempting connection...');
    pool = new Pool(config);

    // Test basic connection
    const result = await pool.query('SELECT 1 as num');
    console.log('[Diagnosis] ✅ Connection successful\n');

    // List tables
    console.log('[Diagnosis] Checking tables...');
    const tables = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );

    if (tables.rows.length === 0) {
      console.log('[Diagnosis] ⚠️  No tables found (schema not initialized)');
      console.log('[Diagnosis] → Run backend server to auto-initialize schema\n');
    } else {
      console.log(`[Diagnosis] ✅ Found ${tables.rows.length} tables:\n`);
      for (const row of tables.rows) {
        console.log(`    - ${row.table_name}`);
      }
      console.log();
    }

    // Count rows
    console.log('[Diagnosis] Row counts:');
    const counts = await pool.query(`
      SELECT
        schemaname,
        tablename,
        n_live_tup as row_count
      FROM pg_stat_user_tables
      ORDER BY n_live_tup DESC
      LIMIT 10
    `);

    if (counts.rows.length > 0) {
      for (const row of counts.rows) {
        console.log(`    ${row.tablename}: ${row.row_count} rows`);
      }
    }
    console.log();

    console.log('[Diagnosis] ✅ ALL CHECKS PASSED');
    console.log('[Diagnosis] Database connection is working!\n');

  } catch (error) {
    console.error('[Diagnosis] ❌ Connection failed!\n');
    console.error('[Diagnosis] Error:', error.message);
    console.error('[Diagnosis]\n');

    if (error.message.includes('connect ECONNREFUSED')) {
      console.error('[Diagnosis] → Database is not running or host is wrong');
      console.error('[Diagnosis] → Check PGHOST and verify database is running\n');
    } else if (error.message.includes('password authentication failed')) {
      console.error('[Diagnosis] → Authentication failed');
      console.error('[Diagnosis] → Check PGUSER and PGPASSWORD\n');
    } else if (error.message.includes('does not exist')) {
      console.error('[Diagnosis] → Database does not exist');
      console.error('[Diagnosis] → Create database with: createdb s88_app\n');
    } else if (error.message.includes('insecure')) {
      console.error('[Diagnosis] → SSL connection issue');
      console.error('[Diagnosis] → For Neon, ensure NODE_ENV=production or ssl option\n');
    }

    process.exit(1);
  } finally {
    if (pool) await pool.end();
  }
}

diagnose();
