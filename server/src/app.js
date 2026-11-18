import express from "express";
import { config } from "./config.js";
import { query } from "./db.js";
import { HttpError } from "./errors.js";
import { createWeather } from "./weather.js";
import * as domain from "./domain.js";
import { getDemoCredentials } from "./seed.js";

const weather = createWeather(config.weatherProvider);
const COOKIE = "hs_session";

function readCookie(header, name) {
  if (!header) return "";
  const part = header.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
}

function writeSession(res, token, expiresAt) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.floor((expiresAt.getTime() - Date.now()) / 1000)}`,
  ];
  if (config.cookieSecure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSession(res) {
  const parts = [`${COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (config.cookieSecure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clientKey(req) {
  return `${req.ip}|${req.get("user-agent") ?? ""}`;
}

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

async function contextFor(req) {
  const now = new Date();
  const sessionToken = readCookie(req.get("cookie"), COOKIE);
  const actor = await domain.resolveActor(query, sessionToken, now);
  return { query, actor, now: () => new Date(), clientKey: clientKey(req), sessionToken, weather };
}

export function createApp() {
  const app = express();
  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    if (config.production) {
      res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    }
    next();
  });
  if (config.webOrigin) {
    app.use((req, res, next) => {
      const origin = req.get("origin");
      if (origin && origin === config.webOrigin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      }
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    });
  }
  app.use(express.json({ limit: "256kb" }));

  app.get("/api/health", asyncRoute(async (_req, res) => {
    await query("SELECT 1");
    res.json({ ok: true, service: "heatshield-api" });
  }));

  app.use(asyncRoute(async (req, _res, next) => {
    req.ctx = await contextFor(req);
    const open = req.path === "/api/health" || req.path === "/api/auth/login" || req.path === "/api/auth/demo";
    const passwordOk = open || req.path === "/api/auth/logout" || req.path === "/api/auth/password" || req.path === "/api/me";
    if (req.ctx.actor?.mustChangePassword && !passwordOk && req.path.startsWith("/api/")) {
      throw new HttpError(403, "Change your password before continuing.");
    }
    next();
  }));

  app.get("/api/auth/demo", asyncRoute(async (_req, res) => {
    res.json(getDemoCredentials());
  }));
  app.post("/api/auth/login", asyncRoute(async (req, res) => {
    const result = await domain.login(req.ctx, req.body ?? {});
    writeSession(res, result.token, result.expiresAt);
    res.json({ ok: true, mustChangePassword: result.mustChangePassword });
  }));
  app.post("/api/auth/logout", asyncRoute(async (req, res) => {
    await domain.logout(req.ctx);
    clearSession(res);
    res.json({ ok: true });
  }));
  app.post("/api/auth/password", asyncRoute(async (req, res) => {
    res.json(await domain.changePassword(req.ctx, req.body ?? {}));
  }));
  app.get("/api/me", asyncRoute(async (req, res) => res.json(await domain.me(req.ctx))));
  app.patch("/api/me", asyncRoute(async (req, res) => res.json(await domain.setLanguage(req.ctx, req.body?.language))));

  app.get("/api/dashboard", asyncRoute(async (req, res) => res.json(await domain.dashboard(req.ctx))));
  app.get("/api/sites", asyncRoute(async (req, res) => res.json(await domain.listSites(req.ctx))));
  app.post("/api/sites", asyncRoute(async (req, res) => res.status(201).json(await domain.createSite(req.ctx, req.body ?? {}))));
  app.get("/api/sites/:id", asyncRoute(async (req, res) => res.json(await domain.getSite(req.ctx, req.params.id))));
  app.patch("/api/sites/:id", asyncRoute(async (req, res) => res.json(await domain.updateSite(req.ctx, req.params.id, req.body ?? {}))));
  app.post("/api/crews", asyncRoute(async (req, res) => res.status(201).json(await domain.saveCrew(req.ctx, req.body ?? {}))));
  app.patch("/api/crews/:id/conditions", asyncRoute(async (req, res) => res.json(await domain.updateCrewConditions(req.ctx, { ...req.body, crewId: req.params.id }))));

  app.get("/api/protocols", asyncRoute(async (req, res) => res.json(await domain.listProtocols(req.ctx))));
  app.get("/api/protocols/active", asyncRoute(async (req, res) => res.json(await domain.getProtocol(req.ctx))));
  app.get("/api/protocols/:id", asyncRoute(async (req, res) => res.json(await domain.getProtocol(req.ctx, req.params.id))));
  app.post("/api/protocols", asyncRoute(async (req, res) => res.status(201).json(await domain.createDraft(req.ctx, req.body ?? {}))));
  app.patch("/api/protocols/:id", asyncRoute(async (req, res) => res.json(await domain.updateDraft(req.ctx, req.params.id, req.body ?? {}))));
  app.post("/api/protocols/:id/submit", asyncRoute(async (req, res) => res.json(await domain.submitDraft(req.ctx, req.params.id))));
  app.post("/api/protocols/:id/approve", asyncRoute(async (req, res) => res.json(await domain.approveProtocol(req.ctx, req.params.id))));
  app.post("/api/protocols/:id/reject", asyncRoute(async (req, res) => res.json(await domain.rejectProtocol(req.ctx, req.params.id, req.body ?? {}))));

  app.post("/api/sites/:id/readings", asyncRoute(async (req, res) => res.status(201).json(await domain.recordReading(req.ctx, { ...req.body, siteId: req.params.id }))));
  app.post("/api/sites/:id/weather", asyncRoute(async (req, res) => res.json(await domain.fetchWeather(req.ctx, req.params.id))));
  app.get("/api/sites/:id/forecast", asyncRoute(async (req, res) => res.json(await domain.forecastFor(req.ctx, req.params.id))));
  app.post("/api/sites/:id/assessments", asyncRoute(async (req, res) => res.status(201).json(await domain.runAssessment(req.ctx, { ...req.body, siteId: req.params.id }))));
  app.get("/api/sites/:id/assessments", asyncRoute(async (req, res) => res.json(await domain.listAssessments(req.ctx, req.params.id, req.query.limit))));

  app.get("/api/actions", asyncRoute(async (req, res) => res.json(await domain.listActions(req.ctx, req.query.view ?? "active", req.query.siteId))));
  app.post("/api/actions", asyncRoute(async (req, res) => res.status(201).json(await domain.createManualAction(req.ctx, req.body ?? {}))));
  app.get("/api/actions/:id", asyncRoute(async (req, res) => res.json(await domain.getAction(req.ctx, req.params.id))));
  app.post("/api/actions/:id/acknowledge", asyncRoute(async (req, res) => res.json(await domain.acknowledgeAction(req.ctx, req.params.id))));
  app.post("/api/actions/:id/complete", asyncRoute(async (req, res) => res.json(await domain.completeAction(req.ctx, req.params.id, req.body ?? {}))));
  app.post("/api/actions/:id/block", asyncRoute(async (req, res) => res.json(await domain.blockAction(req.ctx, req.params.id, req.body ?? {}))));
  app.post("/api/actions/:id/cancel", asyncRoute(async (req, res) => res.json(await domain.cancelAction(req.ctx, req.params.id, req.body ?? {}))));
  app.post("/api/actions/:id/notes", asyncRoute(async (req, res) => res.json(await domain.addNote(req.ctx, req.params.id, req.body ?? {}))));
  app.post("/api/escalations/run", asyncRoute(async (req, res) => res.json(await domain.runEscalations(req.ctx))));

  app.get("/api/worker/status", asyncRoute(async (req, res) => res.json(await domain.workerStatus(req.ctx, req.query.language))));
  app.post("/api/worker/ack", asyncRoute(async (req, res) => res.json(await domain.acknowledgeInstructions(req.ctx, req.body?.assessmentId))));
  app.post("/api/worker/reports", asyncRoute(async (req, res) => res.status(201).json(await domain.submitReport(req.ctx, req.body ?? {}))));

  app.get("/api/insights", asyncRoute(async (req, res) => res.json(await domain.insightsSummary(req.ctx, req.query.days, req.query.siteId))));
  app.get("/api/insights.csv", asyncRoute(async (req, res) => {
    const summary = await domain.insightsSummary(req.ctx, req.query.days, req.query.siteId);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"heatshield-insights.csv\"");
    res.send(domain.insightsCsv(summary));
  }));
  app.get("/api/audit", asyncRoute(async (req, res) => res.json(await domain.listAudit(req.ctx, req.query))));
  app.get("/api/notifications", asyncRoute(async (req, res) => res.json(await domain.listNotifications(req.ctx))));
  app.post("/api/notifications/read", asyncRoute(async (req, res) => res.json(await domain.markNotificationsRead(req.ctx))));

  app.get("/api/users", asyncRoute(async (req, res) => res.json(await domain.listUsers(req.ctx))));
  app.post("/api/users", asyncRoute(async (req, res) => res.status(201).json(await domain.createUser(req.ctx, req.body ?? {}))));
  app.patch("/api/users/:id", asyncRoute(async (req, res) => res.json(await domain.updateUser(req.ctx, req.params.id, req.body ?? {}))));
  app.post("/api/users/:id/reset-password", asyncRoute(async (req, res) => res.json(await domain.resetPassword(req.ctx, req.params.id))));
  app.get("/api/settings", asyncRoute(async (req, res) => res.json(await domain.getSettings(req.ctx))));
  app.patch("/api/settings", asyncRoute(async (req, res) => res.json(await domain.updateSettings(req.ctx, req.body ?? {}))));

  app.use((error, _req, res, _next) => {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error(error);
    const message = status === 500 && config.production ? "Something went wrong. Try again." : error.message || "Request failed.";
    res.status(status).json({ error: message });
  });
  return app;
}
