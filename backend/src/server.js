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

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: 'http://localhost:5173' }));
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

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

async function start() {
  try {
    // sql.js needs async init (loads WebAssembly)
    await initDb();
    ensureSchema();
    app.listen(PORT, () => {
      console.log(`[Server] PCS7 Generator backend → http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[Server] Failed to start:', err.message);
    process.exit(1);
  }
}

start();
