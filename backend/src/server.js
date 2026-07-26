// src/server.js — Express entry point
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors    = require('cors');
const { initDb, ensureSchema } = require('./db');

const libraryRoutes        = require('./routes/library');
const generateRoutes       = require('./routes/generate');
const projectRoutes        = require('./routes/projects');
const unitTypeRoutes       = require('./routes/unitTypes');
const ioRoutes             = require('./routes/io');
const compositeCmRoutes    = require('./routes/compositeCmTypes');
const valveCommandRoutes   = require('./routes/valveCommands');
const hwConfigRoutes       = require('./routes/hwConfig');
const hwControllersRoutes  = require('./routes/hwControllers');
const hwFieldbusesRoutes   = require('./routes/hwFieldbuses');
const mrpConfigRoutes      = require('./routes/mrpConfig');
const signalMappingRoutes  = require('./routes/signalMappings');
const ioConnectionRoutes   = require('./routes/ioConnections');
const connectionRoutes     = require('./routes/connections');
const moduleParametersRoutes = require('./routes/moduleParameters');
const workflowRoutes       = require('./routes/workflow');

const app  = express();
const PORT = process.env.PORT || 3001;

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
app.use(express.json({ limit: '10mb' }));

app.use('/api/library',    libraryRoutes);
app.use('/api/cm-types',  libraryRoutes);
app.use('/api/generate',  generateRoutes);
app.use('/api/projects',  projectRoutes);
app.use('/api/unit-types',        unitTypeRoutes);
app.use('/api/composite-cm-types', compositeCmRoutes);
app.use('/api/io',                ioRoutes);
app.use('/api/valve-commands',   valveCommandRoutes);
app.use('/api/hw-config',        hwConfigRoutes);
app.use('/api/hw-controllers',   hwControllersRoutes);
app.use('/api/hw-fieldbuses',    hwFieldbusesRoutes);
app.use('/api/mrp',              mrpConfigRoutes);
app.use('/api/signal-mappings',  signalMappingRoutes);
app.use('/api/io-connections',   ioConnectionRoutes);
app.use('/api/connections',      connectionRoutes);
app.use('/api/module-parameters', moduleParametersRoutes);
app.use('/api/workflow',         workflowRoutes);

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

async function start() {
  try {
    console.log('[Server] Starting backend server...');
    console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[Server] Database host: ${process.env.PGHOST || 'localhost'}`);

    // sql.js needs async init (loads WebAssembly)
    console.log('[Server] Initializing database...');
    await initDb();
    console.log('[Server] Database initialized');

    console.log('[Server] Ensuring schema...');
    await ensureSchema();
    console.log('[Server] Schema ready');

    const server = app.listen(PORT, () => {
      console.log(`[Server] PCS7 Generator backend → http://localhost:${PORT}`);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[Server] Port ${PORT} is already in use — is another instance still running?`);
      } else {
        console.error('[Server] Server error:', err.message);
      }
      process.exit(1);
    });

    // Release the port cleanly on Ctrl+C / nodemon restart / kill
    const shutdown = (signal) => {
      console.log(`\n[Server] ${signal} received — shutting down…`);
      server.close(() => {
        console.log('[Server] Closed. Port released.');
        process.exit(0);
      });
      // Force-exit if close() hangs on lingering connections
      setTimeout(() => {
        console.error('[Server] Forced shutdown after timeout.');
        process.exit(1);
      }, 5000).unref();
    };

    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    console.error('[Server] Failed to start:', err.message);
    process.exit(1);
  }
}

start();
