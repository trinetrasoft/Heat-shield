# HeatShield Shift

HeatShield Shift helps outdoor crews act on heat risk. Supervisors record conditions, the approved protocol classifies risk, and named people acknowledge protective actions. The application does not decide when work must stop.

The previous build ran PostgreSQL inside one browser. This version is a multi-user service: a React app, a Node API, and PostgreSQL.

## Roles

- **Organization Admin** manages people, sites, retention, and the audit log.
- **Safety Lead** owns the protocol. A different Safety Lead must approve each change.
- **Site Supervisor** runs assessments and closes actions for assigned sites.
- **Worker** sees current instructions and can report a problem without their name being stored on the report.
- **Operations Analyst** sees site-level totals only.

## Run with Docker

```bash
cp .env.example .env
# Set SESSION_SECRET to a long random value before any shared deployment.
docker compose up --build
```

Open http://localhost:8080.

The sample organization is created only when the database is empty and `SEED_DEMO=true`. Every sample account uses `DEMO_PASSWORD` from `.env` (the example value is `Harbour-Yard-24`).

| Login | Role |
| --- | --- |
| admin@heatshield.example | Organization Admin |
| safety.lead@heatshield.example | Safety Lead |
| ohs.advisor@heatshield.example | Safety Lead (second approver) |
| supervisor.north@heatshield.example | Supervisor, North Yard |
| supervisor.harbour@heatshield.example | Supervisor, Harbour Tower and Solar Farm |
| supervisor.depot@heatshield.example | Supervisor, Metro Depot |
| worker.north@heatshield.example | Worker, North Yard |
| worker.harbour@heatshield.example | Worker, Harbour Tower |
| analyst@heatshield.example | Analyst |

Turn `SEED_DEMO` off for a real organization. Set `BOOTSTRAP_ORG_NAME`, `BOOTSTRAP_ADMIN_LOGIN`, and `BOOTSTRAP_ADMIN_PASSWORD` instead. The first admin must change that password at sign-in.

Set `WEATHER_PROVIDER=simulated` when the server cannot reach Open-Meteo. Simulated weather is not a measurement.

## Local development

PostgreSQL must be reachable at `DATABASE_URL`.

```bash
cd server
npm install
npm test
npm run dev
```

```bash
cd web
npm install
npm run dev
```

The Vite server proxies `/api` to http://127.0.0.1:8080.

## Production checks

- Put TLS in front of the web container and set `COOKIE_SECURE=true`.
- Replace `SESSION_SECRET` and the database password.
- Keep `SEED_DEMO=false`.
- Replace the example protocol. Assessments refuse to run until one version is approved, and the interface keeps a warning while `exampleOnly` is true.
- The audit log rejects updates and deletes. Closed actions, readings, sessions, and notifications follow the retention settings. Action records are kept for at least 365 days.
- Accounts lock for 15 minutes after 5 failed passwords. A client is limited to 20 sign-in attempts per 15 minutes.
- Sessions last 12 hours and end after 1 hour of inactivity. Password changes sign out other sessions.

The original single-browser build is kept in `legacy-browser-demo/` for reference. It is not part of the running service.
