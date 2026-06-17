# PCS7 CM Generator — Full Stack App

## Stack
- **Frontend**: React + Vite (port 5173)
- **Backend**: Node.js + Express (port 3001)
- **Database**: SQLite (`backend/data/pcs7_library.db`)

## Quick Start

### 1. Backend
```bash
cd backend
npm install
npm run dev
```

### 2. Frontend (new terminal)
```bash
cd frontend
npm install
npm run dev
```

### 3. Open http://localhost:5173
- Drop `SIE_LIB.XML` once → stored in database permanently
- Define instances → Generate XML → Download

---

## Migration to SQL Server (later)

When you get access to `.\INFSERVER`:

1. Create database: `CREATE DATABASE PCS7Generator`
2. Replace `backend/src/db.js` with the SQL Server version
3. Change `better-sqlite3` → `mssql` in `package.json`
4. Schema SQL is nearly identical (TEXT→NVARCHAR, INTEGER→INT IDENTITY, etc.)
5. All routes, API, and frontend stay exactly the same

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/library/status` | CM count + last load date |
| POST | `/api/library/upload` | Upload SIE_LIB.XML (multipart) |
| GET | `/api/cm-types` | List all CM types |
| GET | `/api/cm-types/:name/blocks` | Full block+var+msg tree |
| POST | `/api/generate` | Generate XML + save audit |
| GET | `/api/generate/history` | Last 50 generations |
| GET | `/api/generate/history/:id` | Single generation detail |

---

## Database Tables (open with DBeaver)

```
backend/data/pcs7_library.db

lib_cm_types      — CM/EM/EPH types from SIE_LIB.XML
lib_blocks        — Sub-blocks per CM type
lib_variables     — Control variables per block
lib_var_links     — InterconnectionSource links
lib_messages      — Alarm/event messages per block
audit_generations — Every XML generation (who, when, what)
audit_instances   — Each CM instance per generation
```
