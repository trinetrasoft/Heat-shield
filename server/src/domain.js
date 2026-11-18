import { config } from "./config.js";
import { hashPassword, passwordProblem, randomToken, sessionKey, tempPassword, sha256Hex, verifyPassword } from "./crypto.js";
import { withTx } from "./db.js";
import { AuthnError, AuthzError, ConflictError, HttpError, NotFoundError, ValidationError } from "./errors.js";
import { assess, heatIndexC } from "./assess.js";
import { DEFAULT_PROTOCOL, LEVEL_LABEL, levelRank, validateProtocol } from "./protocol.js";

export const ROLES = [
  { id: "org_admin", label: "Organization Admin", description: "Manages users, sites, settings and data retention. Can review escalations and the audit log." },
  { id: "safety_lead", label: "Safety Lead", description: "Owns the heat-safety protocol, approves rule changes, reviews escalations and stop-work decisions." },
  { id: "supervisor", label: "Site Supervisor", description: "Runs assessments for assigned sites, acknowledges and completes protective actions." },
  { id: "worker", label: "Worker", description: "Sees current protective instructions for their site and reports problems anonymously." },
  { id: "analyst", label: "Operations Analyst", description: "Read-only access to aggregated site-level insights. No individual records." },
];

const MATRIX = {
  org_admin: ["dashboard.view", "sites.view", "sites.manage", "users.manage", "protocols.view", "assessments.view", "actions.view", "actions.cancel", "escalations.review", "escalations.run", "insights.view", "audit.view", "settings.manage"],
  safety_lead: ["dashboard.view", "sites.view", "crews.conditions", "protocols.view", "protocols.edit", "protocols.approve", "readings.create", "readings.fetch", "assessments.view", "assessments.run", "actions.view", "actions.respond", "actions.create", "actions.cancel", "escalations.review", "escalations.run", "insights.view", "audit.view", "worker.report"],
  supervisor: ["dashboard.view", "sites.view", "crews.conditions", "protocols.view", "readings.create", "readings.fetch", "assessments.view", "assessments.run", "actions.view", "actions.respond", "actions.create", "worker.report"],
  worker: ["worker.status", "worker.report"],
  analyst: ["insights.view"],
};

const SITE_SCOPED = new Set(["supervisor", "worker"]);
const ACTIVE = ["open", "acknowledged", "blocked"];
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const CLIENT_LIMIT = 20;
const GENERIC = "That login ID and password don't match, or the account is locked. Try again or ask your Organization Admin.";
const SESSION_MS = 12 * 60 * 60 * 1000;
const IDLE_MS = 60 * 60 * 1000;
export const DEFAULT_RETENTION = { actions: 730, readings: 180, sessions: 30, notifications: 90 };
export const BARRIERS = [
  { id: "no_water", label: "No drinking water available" },
  { id: "no_shade", label: "No shade available" },
  { id: "no_rest_area", label: "No cool rest area" },
  { id: "no_authority", label: "No authority to change the schedule" },
  { id: "staffing", label: "Not enough staff to rotate" },
  { id: "equipment", label: "Equipment or instrument unavailable" },
  { id: "other", label: "Other" },
];
export const REPORT_LABEL = {
  no_water: "No drinking water",
  no_shade: "No shade",
  no_rest_area: "No cool rest area",
  someone_unwell: "Someone may be unwell",
  other: "Other safety concern",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function can(role, permission) {
  return MATRIX[role]?.includes(permission) ?? false;
}
export function permissionsFor(role) {
  return [...(MATRIX[role] ?? [])];
}
export function roleLabel(role) {
  return ROLES.find((item) => item.id === role)?.label ?? role;
}
function requirePermission(actor, permission) {
  if (!actor) throw new AuthnError();
  if (!can(actor.role, permission)) throw new AuthzError();
}
function hasSiteAccess(actor, siteId) {
  return !SITE_SCOPED.has(actor.role) || actor.siteIds.includes(siteId);
}
function requireSite(actor, siteId) {
  if (!hasSiteAccess(actor, siteId)) throw new NotFoundError("Site not found.");
}
function canRespondToRole(actor, assignedRole) {
  return can(actor.role, "actions.respond") && (actor.role === "safety_lead" || actor.role === assignedRole);
}
function idOf(value, label = "Id") {
  if (typeof value !== "string" || !UUID.test(value)) throw new ValidationError(`${label} is not a valid id.`);
  return value;
}
function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}
function text(value, max, label) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new ValidationError(`${label} is required.`);
  if (trimmed.length > max) throw new ValidationError(`${label} must be ${max} characters or fewer.`);
  return trimmed;
}
function optionalText(value, max) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}
function enumOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new ValidationError(`${label} is not valid.`);
  return value;
}
function checkZone(timezone) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new ValidationError("Unknown time zone. Use an IANA name such as Asia/Dubai.");
  }
}
function facilitiesOf(input = {}) {
  return {
    drinkingWater: Boolean(input.drinkingWater),
    shade: Boolean(input.shade),
    coolRestArea: Boolean(input.coolRestArea),
    notes: String(input.notes ?? "").slice(0, 300),
  };
}
function pickLang(message, language) {
  if (!message) return null;
  return message[language] ?? message.en ?? null;
}

let dummyHashPromise;
function dummyHash() {
  dummyHashPromise ??= hashPassword("not-a-real-account-password");
  return dummyHashPromise;
}

async function audit(query, ctx, entry) {
  const orgId = entry.orgId ?? ctx.actor?.orgId;
  if (!orgId) return;
  await query(
    `INSERT INTO audit_log (org_id, at, actor_id, actor_role, action, entity_type, entity_id, summary, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      orgId,
      ctx.now(),
      ctx.actor?.id ?? null,
      ctx.actor?.role ?? "system",
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.summary,
      JSON.stringify(entry.meta ?? {}),
    ],
  );
}

async function notifyRoles(query, ctx, orgId, roles, note) {
  let recipients = await query(
    `SELECT id, role FROM users WHERE org_id = $1 AND active = true AND role = ANY($2::text[])`,
    [orgId, roles],
  );
  if (note.siteId) {
    const scoped = recipients.filter((user) => user.role === "supervisor" || user.role === "worker");
    if (scoped.length) {
      const links = await query(
        `SELECT user_id FROM user_sites WHERE site_id = $1 AND user_id = ANY($2::uuid[])`,
        [note.siteId, scoped.map((user) => user.id)],
      );
      const allowed = new Set(links.map((link) => link.userId));
      recipients = recipients.filter(
        (user) => (user.role !== "supervisor" && user.role !== "worker") || allowed.has(user.id),
      );
    }
  }
  if (!recipients.length) return 0;
  const params = [];
  const values = recipients.map((user, index) => {
    const base = index * 7;
    params.push(orgId, user.id, ctx.now(), note.kind, note.title, note.body, note.link ?? null);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });
  await query(
    `INSERT INTO notifications (org_id, user_id, created_at, kind, title, body, link) VALUES ${values.join(", ")}`,
    params,
  );
  return recipients.length;
}

async function loadSite(query, actor, siteId) {
  requireSite(actor, siteId);
  const [site] = await query(`SELECT * FROM sites WHERE id = $1 AND org_id = $2`, [siteId, actor.orgId]);
  if (!site) throw new NotFoundError("Site not found.");
  return site;
}

export async function resolveActor(query, token, now) {
  if (!token || token.length !== 64 || !/^[0-9a-f]+$/.test(token)) return null;
  const key = sessionKey(config.sessionSecret, token);
  const [row] = await query(
    `SELECT s.id AS session_id, s.expires_at, s.last_seen_at,
            u.id, u.org_id, u.login_id, u.role, u.role_label, u.active,
            u.must_change_password, u.language
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [key],
  );
  if (!row) return null;
  if (row.expiresAt < now || row.lastSeenAt < new Date(now.getTime() - IDLE_MS) || !row.active) {
    await query(`DELETE FROM sessions WHERE id = $1`, [key]);
    return null;
  }
  if (now.getTime() - row.lastSeenAt.getTime() > 5 * 60_000) {
    await query(`UPDATE sessions SET last_seen_at = $2 WHERE id = $1`, [key, now]);
  }
  const sites = await query(`SELECT site_id FROM user_sites WHERE user_id = $1`, [row.id]);
  return {
    id: row.id,
    orgId: row.orgId,
    loginId: row.loginId,
    role: row.role,
    roleLabel: row.roleLabel,
    siteIds: sites.map((site) => site.siteId),
    mustChangePassword: row.mustChangePassword,
    language: row.language,
  };
}

export async function login(ctx, input) {
  const now = ctx.now();
  const key = sha256Hex(`login:${ctx.clientKey}`);
  const [{ n }] = await ctx.query(
    `SELECT count(*)::int AS n FROM login_attempts WHERE key = $1 AND at > $2`,
    [key, new Date(now.getTime() - 15 * 60_000)],
  );
  if (n >= CLIENT_LIMIT) {
    throw new HttpError(429, "Too many sign-in attempts. Wait 15 minutes and try again.");
  }
  await ctx.query(`INSERT INTO login_attempts (key, at) VALUES ($1, $2)`, [key, now]);
  const loginId = String(input.loginId ?? "").trim().toLowerCase();
  const [user] = await ctx.query(`SELECT * FROM users WHERE login_id = $1 LIMIT 1`, [loginId]);
  if (!user) {
    await verifyPassword(String(input.password ?? ""), await dummyHash());
    throw new AuthnError(GENERIC);
  }
  if (!user.active || (user.lockedUntil && user.lockedUntil > now)) throw new AuthnError(GENERIC);
  if (!(await verifyPassword(String(input.password ?? ""), user.passwordHash))) {
    const failed = user.failedLogins + 1;
    await ctx.query(`UPDATE users SET failed_logins = $2, locked_until = $3 WHERE id = $1`, [
      user.id,
      failed >= MAX_FAILED ? 0 : failed,
      failed >= MAX_FAILED ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null,
    ]);
    if (failed >= MAX_FAILED) {
      await audit(ctx.query, { ...ctx, actor: null }, {
        orgId: user.orgId,
        action: "auth.locked",
        entityType: "user",
        entityId: user.id,
        summary: `Account locked after ${MAX_FAILED} failed sign-ins`,
      });
    }
    throw new AuthnError(GENERIC);
  }
  const token = randomToken(32);
  const actor = { id: user.id, orgId: user.orgId, role: user.role };
  await ctx.query(
    `INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at) VALUES ($1, $2, $3, $3, $4)`,
    [sessionKey(config.sessionSecret, token), user.id, now, new Date(now.getTime() + SESSION_MS)],
  );
  await ctx.query(`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1`, [user.id, now]);
  await audit(ctx.query, { ...ctx, actor }, { action: "auth.login", entityType: "user", entityId: user.id, summary: "Signed in" });
  return { token, expiresAt: new Date(now.getTime() + SESSION_MS), mustChangePassword: user.mustChangePassword };
}

export async function logout(ctx) {
  if (ctx.sessionToken) {
    await ctx.query(`DELETE FROM sessions WHERE id = $1`, [sessionKey(config.sessionSecret, ctx.sessionToken)]);
  }
  if (ctx.actor) {
    await audit(ctx.query, ctx, { action: "auth.logout", entityType: "user", entityId: ctx.actor.id, summary: "Signed out" });
  }
  return { ok: true };
}

export async function changePassword(ctx, input) {
  const actor = ctx.actor;
  if (!actor) throw new AuthnError();
  const problem = passwordProblem(input.newPassword);
  if (problem) throw new ValidationError(problem);
  if (input.newPassword === input.currentPassword) throw new ValidationError("Choose a password you haven't just used.");
  const [user] = await ctx.query(`SELECT * FROM users WHERE id = $1`, [actor.id]);
  if (!user || !(await verifyPassword(String(input.currentPassword ?? ""), user.passwordHash))) {
    throw new ValidationError("Your current password isn't right.");
  }
  const next = await hashPassword(input.newPassword);
  const currentKey = ctx.sessionToken ? sessionKey(config.sessionSecret, ctx.sessionToken) : "";
  await withTx(async (query) => {
    await query(`UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1`, [actor.id, next]);
    await query(`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, [actor.id, currentKey]);
    await audit(query, ctx, {
      action: "auth.password_changed",
      entityType: "user",
      entityId: actor.id,
      summary: "Changed own password; other sessions signed out",
    });
  });
  return { ok: true };
}

export async function me(ctx) {
  if (!ctx.actor) throw new AuthnError();
  const [org] = await ctx.query(`SELECT name, timezone FROM organizations WHERE id = $1`, [ctx.actor.orgId]);
  return {
    ...ctx.actor,
    orgName: org?.name ?? "",
    timezone: org?.timezone ?? "UTC",
    permissions: permissionsFor(ctx.actor.role),
  };
}

export async function setLanguage(ctx, language) {
  if (!ctx.actor) throw new AuthnError();
  enumOf(language, ["en", "hi", "ar"], "Language");
  await ctx.query(`UPDATE users SET language = $2 WHERE id = $1`, [ctx.actor.id, language]);
  return { ok: true };
}

function emptyDashboard() {
  return {
    openActions: 0,
    overdue: 0,
    escalated: 0,
    ackOverdue: 0,
    hotCrews: [],
    pendingApprovals: 0,
    protocol: null,
    statusCounts: { open: 0, acknowledged: 0, blocked: 0 },
    priorityCounts: { urgent: 0, high: 0, routine: 0 },
    riskMix: { low: 0, moderate: 0, high: 0, extreme: 0, unknown: 0 },
    basisMix: { measured: 0, estimated: 0, insufficient: 0 },
    siteLoad: [],
    trend: [],
    generatedAt: new Date().toISOString(),
  };
}

export async function dashboard(ctx) {
  requirePermission(ctx.actor, "dashboard.view");
  const actor = ctx.actor;
  const now = ctx.now();
  const scoped = SITE_SCOPED.has(actor.role);
  if (scoped && !actor.siteIds.length) return emptyDashboard();
  const since = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const actions = await ctx.query(
    `SELECT a.due_at, a.ack_due_at, a.status, a.escalation_level, a.priority, a.created_at, a.site_id, s.name AS site_name
     FROM actions a JOIN sites s ON s.id = a.site_id
     WHERE a.org_id = $1 AND a.status = ANY($2::text[])
       AND ($3::boolean = false OR a.site_id = ANY($4::uuid[]))`,
    [actor.orgId, ACTIVE, scoped, actor.siteIds],
  );
  const latest = await ctx.query(
    `SELECT DISTINCT ON (a.crew_id) a.site_id, a.risk_level, a.basis, a.assessed_at, c.name AS crew_name, s.name AS site_name
     FROM assessments a
     JOIN crews c ON c.id = a.crew_id
     JOIN sites s ON s.id = a.site_id
     WHERE a.org_id = $1 AND a.assessed_at >= $2
       AND ($3::boolean = false OR a.site_id = ANY($4::uuid[]))
     ORDER BY a.crew_id, a.assessed_at DESC`,
    [actor.orgId, since, scoped, actor.siteIds],
  );
  const history = await ctx.query(
    `SELECT assessed_at FROM assessments
     WHERE org_id = $1 AND assessed_at >= $2
       AND ($3::boolean = false OR site_id = ANY($4::uuid[]))`,
    [actor.orgId, since, scoped, actor.siteIds],
  );
  const created = await ctx.query(
    `SELECT created_at FROM actions
     WHERE org_id = $1 AND created_at >= $2
       AND ($3::boolean = false OR site_id = ANY($4::uuid[]))`,
    [actor.orgId, since, scoped, actor.siteIds],
  );
  const pending = can(actor.role, "protocols.approve")
    ? Number((await ctx.query(
        `SELECT count(*)::int AS n FROM protocols WHERE org_id = $1 AND status = 'pending_approval'`,
        [actor.orgId],
      ))[0].n)
    : 0;
  const protocol = can(actor.role, "protocols.view") ? await activeProtocol(ctx.query, actor.orgId) : null;
  const statusCounts = { open: 0, acknowledged: 0, blocked: 0 };
  const priorityCounts = { urgent: 0, high: 0, routine: 0 };
  for (const action of actions) {
    statusCounts[action.status] = (statusCounts[action.status] ?? 0) + 1;
    priorityCounts[action.priority] = (priorityCounts[action.priority] ?? 0) + 1;
  }
  const riskMix = { low: 0, moderate: 0, high: 0, extreme: 0, unknown: 0 };
  const basisMix = { measured: 0, estimated: 0, insufficient: 0 };
  for (const row of latest) {
    riskMix[row.riskLevel] = (riskMix[row.riskLevel] ?? 0) + 1;
    basisMix[row.basis] = (basisMix[row.basis] ?? 0) + 1;
  }
  const bySite = new Map();
  for (const action of actions) {
    const current = bySite.get(action.siteId) ?? { siteId: action.siteId, siteName: action.siteName, openActions: 0, overdue: 0, escalated: 0 };
    current.openActions += 1;
    if (action.dueAt < now) current.overdue += 1;
    if (action.escalationLevel > 0) current.escalated += 1;
    bySite.set(action.siteId, current);
  }
  const trend = [];
  for (let hour = 11; hour >= 0; hour -= 1) {
    const end = new Date(now.getTime() - hour * 60 * 60 * 1000);
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    const label = end.toISOString().slice(11, 16);
    trend.push({
      hour: label,
      assessments: history.filter((row) => row.assessedAt >= start && row.assessedAt < end).length,
      actions: created.filter((row) => row.createdAt >= start && row.createdAt < end).length,
    });
  }
  return {
    openActions: actions.length,
    overdue: actions.filter((action) => action.dueAt < now).length,
    escalated: actions.filter((action) => action.escalationLevel > 0).length,
    ackOverdue: actions.filter((action) => action.status === "open" && action.ackDueAt < now).length,
    hotCrews: latest
      .filter((row) => ["high", "extreme", "unknown"].includes(row.riskLevel))
      .map((row) => ({
        crewName: row.crewName,
        siteName: row.siteName,
        siteId: row.siteId,
        riskLevel: row.riskLevel,
        basis: row.basis,
        assessedAt: row.assessedAt,
      })),
    pendingApprovals: pending,
    protocol: protocol ? { version: protocol.version, exampleOnly: protocol.config.exampleOnly, name: protocol.name } : null,
    statusCounts,
    priorityCounts,
    riskMix,
    basisMix,
    siteLoad: [...bySite.values()].sort((a, b) => b.openActions - a.openActions),
    trend,
    generatedAt: now.toISOString(),
  };
}

async function activeProtocol(query, orgId) {
  const [protocol] = await query(
    `SELECT * FROM protocols WHERE org_id = $1 AND status = 'approved' LIMIT 1`,
    [orgId],
  );
  return protocol ?? null;
}

async function latestAssessments(query, siteIds) {
  if (!siteIds.length) return [];
  return query(
    `SELECT DISTINCT ON (a.crew_id) a.*, c.name AS crew_name
     FROM assessments a JOIN crews c ON c.id = a.crew_id
     WHERE a.site_id = ANY($1::uuid[])
     ORDER BY a.crew_id, a.assessed_at DESC`,
    [siteIds],
  );
}

export async function listSites(ctx) {
  requirePermission(ctx.actor, "sites.view");
  let sites = await ctx.query(`SELECT * FROM sites WHERE org_id = $1 ORDER BY name`, [ctx.actor.orgId]);
  sites = sites.filter((site) => hasSiteAccess(ctx.actor, site.id));
  if (!sites.length) return [];
  const ids = sites.map((site) => site.id);
  const crews = await ctx.query(`SELECT * FROM crews WHERE site_id = ANY($1::uuid[]) AND active = true`, [ids]);
  const counts = await ctx.query(
    `SELECT site_id, count(*)::int AS n FROM actions
     WHERE site_id = ANY($1::uuid[]) AND status = ANY($2::text[]) GROUP BY site_id`,
    [ids, ACTIVE],
  );
  const latest = await latestAssessments(ctx.query, ids);
  return sites.map((site) => ({
    ...site,
    crewCount: crews.filter((crew) => crew.siteId === site.id).length,
    openActions: counts.find((row) => row.siteId === site.id)?.n ?? 0,
    latestAssessments: latest.filter((row) => row.siteId === site.id),
  }));
}

export async function getSite(ctx, siteId) {
  requirePermission(ctx.actor, "sites.view");
  const site = await loadSite(ctx.query, ctx.actor, idOf(siteId, "Site"));
  const [crews, readings, latest] = await Promise.all([
    ctx.query(`SELECT * FROM crews WHERE site_id = $1 ORDER BY name`, [site.id]),
    ctx.query(
      `SELECT * FROM readings WHERE site_id = $1 AND source <> 'forecast' ORDER BY observed_at DESC LIMIT 12`,
      [site.id],
    ),
    latestAssessments(ctx.query, [site.id]),
  ]);
  return { site, crews, readings, latestAssessments: latest };
}

function validateSite(input) {
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new ValidationError("Latitude or longitude is out of range.");
  }
  checkZone(String(input.timezone ?? ""));
  return {
    name: text(input.name, 120, "Site name"),
    code: text(input.code, 12, "Site code").toUpperCase(),
    latitude,
    longitude,
    timezone: String(input.timezone),
    environment: enumOf(input.environment ?? "outdoor", ["outdoor", "indoor", "mixed"], "Environment"),
    facilities: facilitiesOf(input.facilities),
    hasWbgtInstrument: Boolean(input.hasWbgtInstrument),
    active: input.active !== false,
  };
}

export async function createSite(ctx, input) {
  requirePermission(ctx.actor, "sites.manage");
  const site = validateSite(input);
  const [created] = await ctx.query(
    `INSERT INTO sites (org_id, name, code, latitude, longitude, timezone, environment, facilities, has_wbgt_instrument, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING *`,
    [ctx.actor.orgId, site.name, site.code, site.latitude, site.longitude, site.timezone, site.environment, JSON.stringify(site.facilities), site.hasWbgtInstrument, site.active],
  );
  await audit(ctx.query, ctx, { action: "site.created", entityType: "site", entityId: created.id, summary: `Created site ${created.name}` });
  return created;
}

export async function updateSite(ctx, siteId, input) {
  requirePermission(ctx.actor, "sites.manage");
  const existing = await loadSite(ctx.query, ctx.actor, idOf(siteId, "Site"));
  const site = validateSite(input);
  await ctx.query(
    `UPDATE sites SET name=$2, code=$3, latitude=$4, longitude=$5, timezone=$6, environment=$7,
      facilities=$8::jsonb, has_wbgt_instrument=$9, active=$10 WHERE id=$1`,
    [existing.id, site.name, site.code, site.latitude, site.longitude, site.timezone, site.environment, JSON.stringify(site.facilities), site.hasWbgtInstrument, site.active],
  );
  await audit(ctx.query, ctx, {
    action: "site.updated",
    entityType: "site",
    entityId: existing.id,
    summary: `Updated site ${site.name}`,
    meta: { facilitiesBefore: existing.facilities, facilitiesAfter: site.facilities },
  });
  return { ok: true };
}

export async function saveCrew(ctx, input) {
  requirePermission(ctx.actor, "sites.manage");
  const site = await loadSite(ctx.query, ctx.actor, idOf(input.siteId, "Site"));
  if (!/^\d{2}:\d{2}$/.test(input.shiftStart ?? "") || !/^\d{2}:\d{2}$/.test(input.shiftEnd ?? "")) {
    throw new ValidationError("Shift times must be HH:MM.");
  }
  const fields = {
    name: text(input.name, 80, "Crew name"),
    workArea: text(input.workArea, 120, "Work area"),
    taskIntensity: enumOf(input.taskIntensity, ["light", "moderate", "heavy", "very_heavy"], "Work intensity"),
    clothing: enumOf(input.clothing, ["standard", "coveralls", "double_layer", "vapour_barrier"], "Clothing"),
    acclimatization: enumOf(input.acclimatization, ["acclimatized", "mixed", "new_workers"], "Acclimatization"),
    shiftStart: input.shiftStart,
    shiftEnd: input.shiftEnd,
    active: input.active !== false,
  };
  if (input.id) {
    const crewId = idOf(input.id, "Crew");
    const [crew] = await ctx.query(`SELECT * FROM crews WHERE id = $1 AND site_id = $2`, [crewId, site.id]);
    if (!crew) throw new NotFoundError("Crew not found.");
    await ctx.query(
      `UPDATE crews SET name=$2, work_area=$3, task_intensity=$4, clothing=$5, acclimatization=$6,
        shift_start=$7, shift_end=$8, active=$9 WHERE id=$1`,
      [crewId, fields.name, fields.workArea, fields.taskIntensity, fields.clothing, fields.acclimatization, fields.shiftStart, fields.shiftEnd, fields.active],
    );
    await audit(ctx.query, ctx, { action: "crew.updated", entityType: "crew", entityId: crewId, summary: `Updated crew ${fields.name}` });
    return { id: crewId };
  }
  const [created] = await ctx.query(
    `INSERT INTO crews (org_id, site_id, name, work_area, task_intensity, clothing, acclimatization, shift_start, shift_end, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.actor.orgId, site.id, fields.name, fields.workArea, fields.taskIntensity, fields.clothing, fields.acclimatization, fields.shiftStart, fields.shiftEnd, fields.active],
  );
  await audit(ctx.query, ctx, { action: "crew.created", entityType: "crew", entityId: created.id, summary: `Created crew ${fields.name}` });
  return { id: created.id };
}

export async function updateCrewConditions(ctx, input) {
  requirePermission(ctx.actor, "crews.conditions");
  const [crew] = await ctx.query(`SELECT * FROM crews WHERE id = $1 AND org_id = $2`, [idOf(input.crewId, "Crew"), ctx.actor.orgId]);
  if (!crew) throw new NotFoundError("Crew not found.");
  requireSite(ctx.actor, crew.siteId);
  const next = {
    taskIntensity: enumOf(input.taskIntensity, ["light", "moderate", "heavy", "very_heavy"], "Work intensity"),
    clothing: enumOf(input.clothing, ["standard", "coveralls", "double_layer", "vapour_barrier"], "Clothing"),
    acclimatization: enumOf(input.acclimatization, ["acclimatized", "mixed", "new_workers"], "Acclimatization"),
  };
  await ctx.query(`UPDATE crews SET task_intensity=$2, clothing=$3, acclimatization=$4 WHERE id=$1`, [
    crew.id, next.taskIntensity, next.clothing, next.acclimatization,
  ]);
  await audit(ctx.query, ctx, {
    action: "crew.conditions_updated",
    entityType: "crew",
    entityId: crew.id,
    summary: `Updated working conditions for ${crew.name}`,
    meta: { from: { taskIntensity: crew.taskIntensity, clothing: crew.clothing, acclimatization: crew.acclimatization }, to: next },
  });
  return { ok: true };
}

export async function listProtocols(ctx) {
  requirePermission(ctx.actor, "protocols.view");
  const rows = await ctx.query(
    `SELECT id, version, name, status, notes, created_at, submitted_at, approved_at, created_by, submitted_by, approved_by
     FROM protocols WHERE org_id = $1 ORDER BY version DESC`,
    [ctx.actor.orgId],
  );
  const ids = [...new Set(rows.flatMap((row) => [row.createdBy, row.submittedBy, row.approvedBy]).filter(Boolean))];
  const people = ids.length
    ? await ctx.query(`SELECT id, role_label FROM users WHERE id = ANY($1::uuid[])`, [ids])
    : [];
  const label = (userId) => (userId ? people.find((person) => person.id === userId)?.roleLabel ?? "Former user" : null);
  return rows.map((row) => ({
    ...row,
    createdByLabel: label(row.createdBy),
    submittedByLabel: label(row.submittedBy),
    approvedByLabel: label(row.approvedBy),
    isMine: row.createdBy === ctx.actor.id || row.submittedBy === ctx.actor.id,
  }));
}

export async function getProtocol(ctx, protocolId) {
  requirePermission(ctx.actor, "protocols.view");
  const protocol = protocolId
    ? (await ctx.query(`SELECT * FROM protocols WHERE id = $1 AND org_id = $2`, [idOf(protocolId, "Protocol"), ctx.actor.orgId]))[0]
    : await activeProtocol(ctx.query, ctx.actor.orgId);
  if (!protocol) throw new NotFoundError("No protocol found.");
  return { ...protocol, isMine: protocol.createdBy === ctx.actor.id || protocol.submittedBy === ctx.actor.id };
}

export async function createDraft(ctx, input) {
  requirePermission(ctx.actor, "protocols.edit");
  const open = await ctx.query(
    `SELECT id FROM protocols WHERE org_id = $1 AND status = ANY($2::text[])`,
    [ctx.actor.orgId, ["draft", "pending_approval"]],
  );
  if (open.length) throw new ConflictError("There is already a draft or a version awaiting approval. Finish or reject it first.");
  const current = await activeProtocol(ctx.query, ctx.actor.orgId);
  const [{ v }] = await ctx.query(`SELECT COALESCE(max(version), 0)::int AS v FROM protocols WHERE org_id = $1`, [ctx.actor.orgId]);
  const [created] = await ctx.query(
    `INSERT INTO protocols (org_id, version, name, status, config, created_by)
     VALUES ($1, $2, $3, 'draft', $4::jsonb, $5) RETURNING id, version`,
    [ctx.actor.orgId, v + 1, text(input.name || current?.name || "Heat-safety protocol", 120, "Name"), JSON.stringify(current?.config ?? DEFAULT_PROTOCOL), ctx.actor.id],
  );
  await audit(ctx.query, ctx, { action: "protocol.draft_created", entityType: "protocol", entityId: created.id, summary: `Created draft v${created.version}` });
  return created;
}

export async function updateDraft(ctx, protocolId, input) {
  requirePermission(ctx.actor, "protocols.edit");
  const [protocol] = await ctx.query(`SELECT * FROM protocols WHERE id = $1 AND org_id = $2`, [idOf(protocolId, "Protocol"), ctx.actor.orgId]);
  if (!protocol) throw new NotFoundError("Protocol not found.");
  if (protocol.status !== "draft") throw new ConflictError("Only drafts can be edited.");
  const parsed = validateProtocol(input.config);
  if (!parsed.ok) throw new ValidationError(parsed.message);
  await ctx.query(`UPDATE protocols SET name = $2, notes = $3, config = $4::jsonb WHERE id = $1`, [
    protocol.id, text(input.name, 120, "Name"), optionalText(input.notes, 1000), JSON.stringify(parsed.data),
  ]);
  await audit(ctx.query, ctx, { action: "protocol.draft_updated", entityType: "protocol", entityId: protocol.id, summary: `Edited draft v${protocol.version}` });
  return { ok: true };
}

export async function submitDraft(ctx, protocolId) {
  requirePermission(ctx.actor, "protocols.edit");
  return withTx(async (query) => {
    const [protocol] = await query(
      `UPDATE protocols SET status = 'pending_approval', submitted_by = $3, submitted_at = $4
       WHERE id = $1 AND org_id = $2 AND status = 'draft' RETURNING *`,
      [idOf(protocolId, "Protocol"), ctx.actor.orgId, ctx.actor.id, ctx.now()],
    );
    if (!protocol) throw new ConflictError("This version isn't a draft any more.");
    const parsed = validateProtocol(protocol.config);
    if (!parsed.ok) throw new ValidationError(parsed.message);
    await audit(query, ctx, { action: "protocol.submitted", entityType: "protocol", entityId: protocol.id, summary: `Submitted v${protocol.version} for approval` });
    await notifyRoles(query, ctx, ctx.actor.orgId, ["safety_lead"], {
      kind: "protocol",
      title: `Protocol v${protocol.version} needs a second approver`,
      body: "A Safety Lead other than the submitter must review and approve it.",
      link: `/protocols/${protocol.id}`,
    });
    return { ok: true };
  });
}

export async function approveProtocol(ctx, protocolId) {
  requirePermission(ctx.actor, "protocols.approve");
  return withTx(async (query) => {
    const [protocol] = await query(`SELECT * FROM protocols WHERE id = $1 AND org_id = $2`, [idOf(protocolId, "Protocol"), ctx.actor.orgId]);
    if (!protocol) throw new NotFoundError("Protocol not found.");
    if (protocol.status !== "pending_approval") throw new ConflictError("Only versions awaiting approval can be approved.");
    if (protocol.submittedBy === ctx.actor.id || protocol.createdBy === ctx.actor.id) {
      throw new ConflictError("Two-person rule: someone other than the author or submitter must approve.");
    }
    await query(`UPDATE protocols SET status = 'retired' WHERE org_id = $1 AND status = 'approved'`, [ctx.actor.orgId]);
    await query(`UPDATE protocols SET status = 'approved', approved_by = $2, approved_at = $3 WHERE id = $1`, [protocol.id, ctx.actor.id, ctx.now()]);
    await audit(query, ctx, { action: "protocol.approved", entityType: "protocol", entityId: protocol.id, summary: `Approved v${protocol.version}; previous version retired` });
    await notifyRoles(query, ctx, ctx.actor.orgId, ["safety_lead", "supervisor", "org_admin"], {
      kind: "protocol",
      title: `Protocol v${protocol.version} is now active`,
      body: "New assessments use the updated thresholds and controls.",
      link: `/protocols/${protocol.id}`,
    });
    return { ok: true };
  });
}

export async function rejectProtocol(ctx, protocolId, input) {
  requirePermission(ctx.actor, "protocols.approve");
  const reason = text(input.reason, 500, "Reason");
  const [protocol] = await ctx.query(
    `UPDATE protocols SET status = 'rejected', notes = $3 WHERE id = $1 AND org_id = $2 AND status = 'pending_approval' RETURNING *`,
    [idOf(protocolId, "Protocol"), ctx.actor.orgId, reason],
  );
  if (!protocol) throw new ConflictError("Only versions awaiting approval can be rejected.");
  await audit(ctx.query, ctx, { action: "protocol.rejected", entityType: "protocol", entityId: protocol.id, summary: `Rejected v${protocol.version}`, meta: { reason } });
  return { ok: true };
}

export async function recordReading(ctx, input) {
  requirePermission(ctx.actor, "readings.create");
  const site = await loadSite(ctx.query, ctx.actor, idOf(input.siteId, "Site"));
  const source = enumOf(input.source, ["onsite_wbgt", "manual"], "Source");
  const now = ctx.now();
  const observedAt = input.observedAt ? new Date(input.observedAt) : now;
  if (Number.isNaN(observedAt.getTime())) throw new ValidationError("Observation time is not a valid date.");
  if (observedAt.getTime() > now.getTime() + 5 * 60_000) throw new ValidationError("Observation time can't be in the future.");
  const num = (value) => (value == null || value === "" ? null : Number(value));
  const wbgtC = num(input.wbgtC);
  const airTempC = num(input.airTempC);
  const relativeHumidity = num(input.relativeHumidity);
  const windMs = num(input.windMs);
  if (source === "onsite_wbgt" && (wbgtC == null || wbgtC < -10 || wbgtC > 50)) {
    throw new ValidationError("Enter a WBGT value between -10 and 50 °C from the instrument.");
  }
  if (source === "manual" && wbgtC == null && (airTempC == null || relativeHumidity == null)) {
    throw new ValidationError("Enter either a WBGT value, or both air temperature and relative humidity.");
  }
  if (airTempC != null && (airTempC < -40 || airTempC > 65)) throw new ValidationError("Air temperature must be between -40 and 65 °C.");
  if (relativeHumidity != null && (relativeHumidity < 0 || relativeHumidity > 100)) throw new ValidationError("Humidity must be 0–100%.");
  if (windMs != null && (windMs < 0 || windMs > 80)) throw new ValidationError("Wind speed must be between 0 and 80 m/s.");
  const heat = airTempC != null && relativeHumidity != null ? heatIndexC(airTempC, relativeHumidity) : null;
  const [reading] = await ctx.query(
    `INSERT INTO readings (org_id, site_id, source, observed_at, received_at, air_temp_c, relative_humidity, wind_ms, wbgt_c, heat_index_c, provider, recorded_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [ctx.actor.orgId, site.id, source, observedAt, now, airTempC, relativeHumidity, windMs, wbgtC, heat, source === "onsite_wbgt" ? "On-site instrument" : "Manual entry", ctx.actor.id, optionalText(input.notes, 500)],
  );
  await audit(ctx.query, ctx, {
    action: "reading.recorded",
    entityType: "reading",
    entityId: reading.id,
    summary: `Recorded ${source === "onsite_wbgt" ? `on-site WBGT ${wbgtC} °C` : "manual reading"} at ${site.name}`,
  });
  return reading;
}

export async function fetchWeather(ctx, siteId) {
  requirePermission(ctx.actor, "readings.fetch");
  const site = await loadSite(ctx.query, ctx.actor, idOf(siteId, "Site"));
  const now = ctx.now();
  let weather;
  try {
    weather = await ctx.weather.fetch(site.latitude, site.longitude, now);
  } catch (cause) {
    throw Object.assign(new Error(`Couldn't get weather data from ${ctx.weather.label}. Record an on-site or manual reading instead.`), { status: 502, cause });
  }
  const usable = (row) => Number.isFinite(row?.airTempC) && Number.isFinite(row?.relativeHumidity) && row.observedAt instanceof Date && !Number.isNaN(row.observedAt.getTime());
  const rows = [];
  const base = { orgId: ctx.actor.orgId, siteId: site.id, receivedAt: now, provider: ctx.weather.label, recordedBy: ctx.actor.id };
  if (usable(weather.current)) rows.push({ ...base, source: "current", ...weather.current, heatIndexC: heatIndexC(weather.current.airTempC, weather.current.relativeHumidity) });
  const horizon = now.getTime() + 12 * 60 * 60 * 1000;
  for (const hour of (weather.hourly ?? []).filter((hour) => usable(hour) && hour.observedAt.getTime() >= now.getTime() - 3_600_000 && hour.observedAt.getTime() <= horizon)) {
    rows.push({ ...base, source: "forecast", ...hour, heatIndexC: heatIndexC(hour.airTempC, hour.relativeHumidity) });
  }
  await withTx(async (query) => {
    await query(
      `DELETE FROM readings WHERE site_id = $1 AND source = 'forecast' AND observed_at >= $2`,
      [site.id, new Date(now.getTime() - 3_600_000)],
    );
    for (const row of rows) {
      await query(
        `INSERT INTO readings (org_id, site_id, source, observed_at, received_at, air_temp_c, relative_humidity, wind_ms, heat_index_c, provider, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [row.orgId, row.siteId, row.source, row.observedAt, row.receivedAt, row.airTempC, row.relativeHumidity, row.windMs, row.heatIndexC, row.provider, row.recordedBy],
      );
    }
    await audit(query, ctx, { action: "reading.fetched", entityType: "site", entityId: site.id, summary: `Fetched ${rows.length} weather rows from ${ctx.weather.label}` });
  });
  return { inserted: rows.length, provider: ctx.weather.label };
}

export async function forecastFor(ctx, siteId) {
  requirePermission(ctx.actor, "assessments.view");
  const site = idOf(siteId, "Site");
  requireSite(ctx.actor, site);
  return ctx.query(
    `SELECT * FROM readings WHERE site_id = $1 AND source = 'forecast' AND observed_at >= $2 ORDER BY observed_at LIMIT 13`,
    [site, new Date(ctx.now().getTime() - 3_600_000)],
  );
}

async function createActionsForControls(query, ctx, spec) {
  const now = ctx.now();
  const existing = spec.crewId
    ? await query(
        `SELECT control_id FROM actions WHERE crew_id = $1 AND status = ANY($2::text[])`,
        [spec.crewId, ACTIVE],
      )
    : [];
  const open = new Set(existing.map((row) => row.controlId));
  const created = [];
  for (const controlId of spec.controlIds) {
    if (open.has(controlId) && spec.source === "assessment") continue;
    const control = spec.cfg.controls.find((item) => item.id === controlId);
    if (!control) continue;
    const [action] = await query(
      `INSERT INTO actions (org_id, site_id, crew_id, assessment_id, control_id, title, instructions, priority, assigned_role, source, created_at, ack_due_at, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        spec.orgId, spec.siteId, spec.crewId, spec.assessmentId, control.id, control.title,
        spec.extraInstructions ? `${control.instructions}\n\n${spec.extraInstructions}` : control.instructions,
        control.priority, control.assignedRole, spec.source, now, addMinutes(now, control.ackMinutes), addMinutes(now, control.dueMinutes),
      ],
    );
    await query(
      `INSERT INTO action_events (org_id, action_id, at, actor_id, actor_role, type, detail)
       VALUES ($1,$2,$3,$4,$5,'created',$6::jsonb)`,
      [spec.orgId, action.id, now, ctx.actor?.id ?? null, ctx.actor?.role ?? "system", JSON.stringify({ source: spec.source })],
    );
    created.push(action.id);
  }
  return created;
}

export async function runAssessment(ctx, input) {
  requirePermission(ctx.actor, "assessments.run");
  const site = await loadSite(ctx.query, ctx.actor, idOf(input.siteId, "Site"));
  let fetchError = null;
  if (input.fetch) {
    try {
      await fetchWeather(ctx, site.id);
    } catch (error) {
      fetchError = error.message;
    }
  }
  const protocol = await activeProtocol(ctx.query, ctx.actor.orgId);
  if (!protocol) throw new ValidationError("No approved heat-safety protocol. A Safety Lead must approve one before assessments can run.");
  const crews = await ctx.query(
    `SELECT * FROM crews WHERE site_id = $1 AND active = true AND ($2::uuid IS NULL OR id = $2)`,
    [site.id, input.crewId ? idOf(input.crewId, "Crew") : null],
  );
  if (!crews.length) throw new ValidationError("This site has no active crews to assess.");
  const now = ctx.now();
  const readings = await ctx.query(
    `SELECT * FROM readings WHERE site_id = $1 AND observed_at >= $2 AND observed_at <= $3 ORDER BY observed_at DESC`,
    [site.id, new Date(now.getTime() - 24 * 60 * 60 * 1000), new Date(now.getTime() + 13 * 60 * 60 * 1000)],
  );
  const results = await withTx(async (query) => {
    const out = [];
    for (const crew of crews) {
      const result = assess({ cfg: protocol.config, protocolVersion: protocol.version, site, crew, readings, now });
      if (fetchError) result.dataIssues.unshift(fetchError);
      const [assessment] = await query(
        `INSERT INTO assessments (org_id, site_id, crew_id, protocol_id, protocol_version, reading_id, assessed_at, assessed_by, trigger, metric, metric_value, adjusted_value, risk_level, basis, data_issues, reasons, controls, requires_human_review)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17) RETURNING *`,
        [ctx.actor.orgId, site.id, crew.id, protocol.id, protocol.version, result.readingId, now, ctx.actor.id, result.metric, result.metricValue, result.adjustedValue, result.riskLevel, result.basis, JSON.stringify(result.dataIssues), JSON.stringify(result.reasons), JSON.stringify(result.controls), result.requiresHumanReview],
      );
      const actionIds = await createActionsForControls(query, ctx, {
        orgId: ctx.actor.orgId, siteId: site.id, crewId: crew.id, assessmentId: assessment.id,
        cfg: protocol.config, controlIds: result.controls, source: "assessment",
      });
      await audit(query, ctx, {
        action: "assessment.run",
        entityType: "assessment",
        entityId: assessment.id,
        summary: `${crew.name} at ${site.name}: ${LEVEL_LABEL[result.riskLevel]} (${result.basis}); ${actionIds.length} action(s) created`,
      });
      if (result.riskLevel === "unknown" || levelRank(result.riskLevel) >= levelRank("high")) {
        await notifyRoles(query, ctx, ctx.actor.orgId, ["supervisor", "safety_lead"], {
          kind: "risk",
          siteId: site.id,
          title: `${LEVEL_LABEL[result.riskLevel]} heat risk — ${crew.name}, ${site.name}`,
          body: result.riskLevel === "unknown" ? "Data is missing or stale. Apply the manual procedure." : `${actionIds.length} protective action(s) assigned.`,
          link: `/sites/${site.id}`,
        });
      }
      out.push({ assessment, crewName: crew.name, actionsCreated: actionIds.length });
    }
    return out;
  });
  return { results, fetchError, protocolVersion: protocol.version, exampleProtocol: protocol.config.exampleOnly };
}

export async function listAssessments(ctx, siteId, limit = 20) {
  requirePermission(ctx.actor, "assessments.view");
  const id = idOf(siteId, "Site");
  requireSite(ctx.actor, id);
  return ctx.query(
    `SELECT a.*, c.name AS crew_name FROM assessments a JOIN crews c ON c.id = a.crew_id
     WHERE a.site_id = $1 AND a.org_id = $2 ORDER BY a.assessed_at DESC LIMIT $3`,
    [id, ctx.actor.orgId, Math.min(Number(limit) || 20, 100)],
  );
}

export async function listActions(ctx, view = "active", siteId) {
  requirePermission(ctx.actor, "actions.view");
  const params = [ctx.actor.orgId];
  const where = ["a.org_id = $1"];
  if (siteId) {
    const id = idOf(siteId, "Site");
    requireSite(ctx.actor, id);
    params.push(id);
    where.push(`a.site_id = $${params.length}`);
  } else if (SITE_SCOPED.has(ctx.actor.role)) {
    if (!ctx.actor.siteIds.length) return [];
    params.push(ctx.actor.siteIds);
    where.push(`a.site_id = ANY($${params.length}::uuid[])`);
  }
  if (view === "active") where.push(`a.status = ANY('{open,acknowledged,blocked}')`);
  if (view === "escalated") where.push(`a.status = ANY('{open,acknowledged,blocked}') AND a.escalation_level > 0`);
  if (view === "closed") where.push(`a.status = ANY('{completed,cancelled}')`);
  const rows = await ctx.query(
    `SELECT a.*, s.name AS site_name, c.name AS crew_name
     FROM actions a JOIN sites s ON s.id = a.site_id LEFT JOIN crews c ON c.id = a.crew_id
     WHERE ${where.join(" AND ")}
     ORDER BY ${view === "closed" ? "a.completed_at DESC NULLS LAST" : "a.due_at ASC"}
     LIMIT 300`,
    params,
  );
  const now = ctx.now();
  const rank = { urgent: 0, high: 1, routine: 2 };
  return rows
    .map((action) => ({
      ...action,
      overdue: ACTIVE.includes(action.status) && action.dueAt < now,
      ackOverdue: action.status === "open" && action.ackDueAt < now,
      canRespond: canRespondToRole(ctx.actor, action.assignedRole),
    }))
    .sort((a, b) => (view === "closed" ? 0 : rank[a.priority] - rank[b.priority] || a.dueAt - b.dueAt));
}

async function loadAction(query, actor, actionId) {
  const [action] = await query(`SELECT * FROM actions WHERE id = $1 AND org_id = $2`, [idOf(actionId, "Action"), actor.orgId]);
  if (!action || !hasSiteAccess(actor, action.siteId)) throw new NotFoundError("Action not found.");
  return action;
}

export async function getAction(ctx, actionId) {
  requirePermission(ctx.actor, "actions.view");
  const action = await loadAction(ctx.query, ctx.actor, actionId);
  const [site] = await ctx.query(`SELECT name FROM sites WHERE id = $1`, [action.siteId]);
  const crew = action.crewId
    ? (await ctx.query(`SELECT name, work_area FROM crews WHERE id = $1`, [action.crewId]))[0] ?? null
    : null;
  const events = await ctx.query(
    `SELECT e.*, u.role_label FROM action_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.action_id = $1 ORDER BY e.at`,
    [action.id],
  );
  const assessment = action.assessmentId
    ? (await ctx.query(`SELECT * FROM assessments WHERE id = $1`, [action.assessmentId]))[0] ?? null
    : null;
  return {
    action: { ...action, overdue: ACTIVE.includes(action.status) && action.dueAt < ctx.now() },
    siteName: site?.name ?? "",
    crew,
    assessment,
    events: events.map((event) => ({ ...event, actorLabel: event.roleLabel ?? (event.actorRole === "system" ? "System" : event.actorRole) })),
    canRespond: canRespondToRole(ctx.actor, action.assignedRole),
    canCancel: can(ctx.actor.role, "actions.cancel"),
  };
}

function assertRespond(actor, action) {
  requirePermission(actor, "actions.respond");
  if (!canRespondToRole(actor, action.assignedRole)) throw new AuthzError("This action is assigned to another role.");
}

export async function acknowledgeAction(ctx, actionId) {
  const action = await loadAction(ctx.query, ctx.actor, actionId);
  assertRespond(ctx.actor, action);
  const now = ctx.now();
  const [updated] = await ctx.query(
    `UPDATE actions SET status = 'acknowledged', acknowledged_at = $2, acknowledged_by = $3
     WHERE id = $1 AND status = 'open' RETURNING id`,
    [action.id, now, ctx.actor.id],
  );
  if (!updated) throw new ConflictError("This action has already been acknowledged or closed.");
  await ctx.query(
    `INSERT INTO action_events (org_id, action_id, at, actor_id, actor_role, type) VALUES ($1,$2,$3,$4,$5,'acknowledged')`,
    [action.orgId, action.id, now, ctx.actor.id, ctx.actor.role],
  );
  await audit(ctx.query, ctx, { action: "action.acknowledged", entityType: "action", entityId: action.id, summary: `Acknowledged: ${action.title}` });
  return { ok: true };
}

export async function completeAction(ctx, actionId, input) {
  const action = await loadAction(ctx.query, ctx.actor, actionId);
  assertRespond(ctx.actor, action);
  if (action.status === "blocked" && ctx.actor.role !== "safety_lead") {
    throw new AuthzError("A blocked action is resolved by a Safety Lead.");
  }
  const now = ctx.now();
  const note = optionalText(input.note, 1000);
  const [updated] = await ctx.query(
    `UPDATE actions SET status = 'completed', completed_at = $2, completed_by = $3, resolution_note = $4,
      acknowledged_at = COALESCE(acknowledged_at, $2), acknowledged_by = COALESCE(acknowledged_by, $3)
     WHERE id = $1 AND status = ANY($5::text[]) RETURNING id`,
    [action.id, now, ctx.actor.id, note, ACTIVE],
  );
  if (!updated) throw new ConflictError("This action is already closed.");
  await ctx.query(
    `INSERT INTO action_events (org_id, action_id, at, actor_id, actor_role, type, detail) VALUES ($1,$2,$3,$4,$5,'completed',$6::jsonb)`,
    [action.orgId, action.id, now, ctx.actor.id, ctx.actor.role, JSON.stringify({ onTime: now <= action.dueAt, note })],
  );
  await audit(ctx.query, ctx, { action: "action.completed", entityType: "action", entityId: action.id, summary: `Completed${now > action.dueAt ? " (late)" : ""}: ${action.title}` });
  return { ok: true };
}

export async function blockAction(ctx, actionId, input) {
  const action = await loadAction(ctx.query, ctx.actor, actionId);
  assertRespond(ctx.actor, action);
  const note = text(input.note, 1000, "A description of the barrier");
  const barrier = enumOf(input.barrier, BARRIERS.map((item) => item.id), "Barrier");
  const now = ctx.now();
  await withTx(async (query) => {
    const [updated] = await query(
      `UPDATE actions SET status = 'blocked', barrier = $2, resolution_note = $3, escalation_level = GREATEST(1, escalation_level), last_escalated_at = $4
       WHERE id = $1 AND status = ANY('{open,acknowledged}') RETURNING id`,
      [action.id, barrier, note, now],
    );
    if (!updated) throw new ConflictError("Only open or acknowledged actions can be marked as blocked.");
    await query(
      `INSERT INTO action_events (org_id, action_id, at, actor_id, actor_role, type, detail) VALUES
       ($1,$2,$3,$4,$5,'blocked',$6::jsonb),
       ($1,$2,$3,NULL,'system','escalated',$7::jsonb)`,
      [action.orgId, action.id, now, ctx.actor.id, ctx.actor.role, JSON.stringify({ barrier, note }), JSON.stringify({ level: 1, reason: "Blocked by a barrier" })],
    );
    await audit(query, ctx, { action: "action.blocked", entityType: "action", entityId: action.id, summary: `Blocked (${barrier}): ${action.title}` });
    await notifyRoles(query, ctx, action.orgId, action.assignedRole === "safety_lead" ? ["org_admin"] : ["safety_lead"], {
      kind: "escalation",
      title: `Blocked: ${action.title}`,
      body: BARRIERS.find((item) => item.id === barrier)?.label ?? "Barrier reported",
      link: `/actions/${action.id}`,
    });
  });
  return { ok: true };
}

export async function cancelAction(ctx, actionId, input) {
  requirePermission(ctx.actor, "actions.cancel");
  const action = await loadAction(ctx.query, ctx.actor, actionId);
  const reason = text(input.reason, 1000, "A reason for cancelling");
  const now = ctx.now();
  const [updated] = await ctx.query(
    `UPDATE actions SET status = 'cancelled', completed_at = $2, completed_by = $3, resolution_note = $4
     WHERE id = $1 AND status = ANY($5::text[]) RETURNING id`,
    [action.id, now, ctx.actor.id, reason, ACTIVE],
  );
  if (!updated) throw new ConflictError("This action is already closed.");
  await ctx.query(
    `INSERT INTO action_events (org_id, action_id, at, actor_id, actor_role, type, detail) VALUES ($1,$2,$3,$4,$5,'cancelled',$6::jsonb)`,
    [action.orgId, action.id, now, ctx.actor.id, ctx.actor.role, JSON.stringify({ reason })],
  );
  await audit(ctx.query, ctx, { action: "action.cancelled", entityType: "action", entityId: action.id, summary: `Cancelled: ${action.title}`, meta: { reason } });
  return { ok: true };
}

export async function addNote(ctx, actionId, input) {
  requirePermission(ctx.actor, "actions.view");
  const action = await loadAction(ctx.query, ctx.actor, actionId);
  if (!canRespondToRole(ctx.actor, action.assignedRole) && !["safety_lead", "org_admin"].includes(ctx.actor.role)) throw new AuthzError();
  const note = text(input.note, 1000, "Note");
  await ctx.query(
    `INSERT INTO action_events (org_id, action_id, at, actor_id, actor_role, type, detail) VALUES ($1,$2,$3,$4,$5,'note',$6::jsonb)`,
    [action.orgId, action.id, ctx.now(), ctx.actor.id, ctx.actor.role, JSON.stringify({ note })],
  );
  return { ok: true };
}

export async function createManualAction(ctx, input) {
  requirePermission(ctx.actor, "actions.create");
  const site = await loadSite(ctx.query, ctx.actor, idOf(input.siteId, "Site"));
  let crewId = null;
  if (input.crewId) {
    crewId = idOf(input.crewId, "Crew");
    const [crew] = await ctx.query(`SELECT id FROM crews WHERE id = $1 AND site_id = $2`, [crewId, site.id]);
    if (!crew) throw new ValidationError("That crew isn't at this site.");
  }
  const title = text(input.title, 120, "Title");
  const instructions = text(input.instructions, 1000, "Instructions");
  const priority = enumOf(input.priority, ["routine", "high", "urgent"], "Priority");
  const assignedRole = enumOf(input.assignedRole, ["supervisor", "safety_lead"], "Assigned role");
  const dueMinutes = Math.min(Math.max(Number(input.dueMinutes) || 60, 5), 1440);
  const now = ctx.now();
  const id = await withTx(async (query) => {
    const [action] = await query(
      `INSERT INTO actions (org_id, site_id, crew_id, control_id, title, instructions, priority, assigned_role, source, created_at, ack_due_at, due_at)
       VALUES ($1,$2,$3,'manual',$4,$5,$6,$7,'manual',$8,$9,$10) RETURNING id`,
      [ctx.actor.orgId, site.id, crewId, title, instructions, priority, assignedRole, now, addMinutes(now, Math.min(15, dueMinutes)), addMinutes(now, dueMinutes)],
    );
    await query(
      `INSERT INTO action_events (org_id, action_id, at, actor_id, actor_role, type, detail) VALUES ($1,$2,$3,$4,$5,'created',$6::jsonb)`,
      [ctx.actor.orgId, action.id, now, ctx.actor.id, ctx.actor.role, JSON.stringify({ source: "manual" })],
    );
    await audit(query, ctx, { action: "action.created", entityType: "action", entityId: action.id, summary: `Created manual action: ${title}` });
    await notifyRoles(query, ctx, ctx.actor.orgId, [assignedRole], {
      kind: "action", siteId: site.id, title: `New action: ${title}`, body: site.name, link: `/actions/${action.id}`,
    });
    return action.id;
  });
  return { id };
}

export async function runEscalations(ctx, orgId) {
  if (ctx.actor) requirePermission(ctx.actor, "escalations.run");
  const now = ctx.now();
  const scope = orgId ?? ctx.actor?.orgId ?? null;
  const due = await ctx.query(
    `SELECT * FROM actions
     WHERE ($1::uuid IS NULL OR org_id = $1)
       AND status = ANY('{open,acknowledged}')
       AND (
         (escalation_level = 0 AND (due_at < $2 OR (status = 'open' AND ack_due_at < $2)))
         OR escalation_level = 1
       )`,
    [scope, now],
  );
  let level1 = 0;
  let level2 = 0;
  const windows = new Map();
  for (const action of due) {
    if (!windows.has(action.orgId)) {
      const protocol = await activeProtocol(ctx.query, action.orgId);
      windows.set(action.orgId, protocol?.config?.escalation?.level2AfterMinutes ?? 30);
    }
    const windowMinutes = windows.get(action.orgId);
    await withTx(async (query) => {
      if (action.escalationLevel === 0) {
        const reason = action.status === "open" && action.ackDueAt < now ? "Not acknowledged in time" : "Not completed by the deadline";
        const [updated] = await query(
          `UPDATE actions SET escalation_level = 1, last_escalated_at = $2 WHERE id = $1 AND escalation_level = 0 RETURNING id`,
          [action.id, now],
        );
        if (!updated) return;
        await query(
          `INSERT INTO action_events (org_id, action_id, at, actor_role, type, detail) VALUES ($1,$2,$3,'system','escalated',$4::jsonb)`,
          [action.orgId, action.id, now, JSON.stringify({ level: 1, reason })],
        );
        const quiet = { ...ctx, actor: null };
        await notifyRoles(query, quiet, action.orgId, action.assignedRole === "safety_lead" ? ["org_admin"] : ["safety_lead"], {
          kind: "escalation", title: `Escalated: ${action.title}`, body: reason, link: `/actions/${action.id}`,
        });
        await audit(query, quiet, { orgId: action.orgId, action: "action.escalated", entityType: "action", entityId: action.id, summary: `Level 1 escalation — ${reason}` });
        level1 += 1;
      } else if (action.escalationLevel === 1 && action.lastEscalatedAt && addMinutes(action.lastEscalatedAt, windowMinutes) < now) {
        const [updated] = await query(
          `UPDATE actions SET escalation_level = 2, last_escalated_at = $2 WHERE id = $1 AND escalation_level = 1 RETURNING id`,
          [action.id, now],
        );
        if (!updated) return;
        const reason = `Still unresolved ${windowMinutes} min after escalation`;
        await query(
          `INSERT INTO action_events (org_id, action_id, at, actor_role, type, detail) VALUES ($1,$2,$3,'system','escalated',$4::jsonb)`,
          [action.orgId, action.id, now, JSON.stringify({ level: 2, reason })],
        );
        const quiet = { ...ctx, actor: null };
        await notifyRoles(query, quiet, action.orgId, ["org_admin", "safety_lead"], {
          kind: "escalation", title: `Second escalation: ${action.title}`, body: `Still unresolved ${windowMinutes} minutes after the first escalation.`, link: `/actions/${action.id}`,
        });
        await audit(query, quiet, { orgId: action.orgId, action: "action.escalated", entityType: "action", entityId: action.id, summary: "Level 2 escalation" });
        level2 += 1;
      }
    });
  }
  return { checked: due.length, level1, level2 };
}

export async function workerStatus(ctx, language) {
  requirePermission(ctx.actor, "worker.status");
  const lang = enumOf(language ?? ctx.actor.language, ["en", "hi", "ar"], "Language");
  if (!ctx.actor.siteIds.length) return { sites: [], language: lang, translationNote: null };
  const protocol = await activeProtocol(ctx.query, ctx.actor.orgId);
  const sites = await ctx.query(`SELECT * FROM sites WHERE id = ANY($1::uuid[]) AND org_id = $2`, [ctx.actor.siteIds, ctx.actor.orgId]);
  const crews = await ctx.query(`SELECT * FROM crews WHERE site_id = ANY($1::uuid[]) AND active = true`, [ctx.actor.siteIds]);
  const latest = await latestAssessments(ctx.query, ctx.actor.siteIds);
  const acks = latest.length
    ? await ctx.query(
        `SELECT assessment_id FROM instruction_acks WHERE user_id = $1 AND assessment_id = ANY($2::uuid[])`,
        [ctx.actor.id, latest.map((row) => row.id)],
      )
    : [];
  const acked = new Set(acks.map((row) => row.assessmentId));
  return {
    language: lang,
    translationNote: lang === "en" ? null : protocol?.config.translationNote ?? null,
    sites: sites.map((site) => ({
      id: site.id,
      name: site.name,
      facilities: site.facilities,
      crews: crews.filter((crew) => crew.siteId === site.id).map((crew) => {
        const assessment = latest.find((row) => row.crewId === crew.id);
        const level = assessment?.riskLevel ?? "unknown";
        const instructions = [...new Set((assessment?.controls ?? [])
          .map((controlId) => protocol?.config.controls.find((control) => control.id === controlId))
          .map((control) => pickLang(control?.worker, lang))
          .filter(Boolean))];
        return {
          id: crew.id,
          name: crew.name,
          workArea: crew.workArea,
          assessmentId: assessment?.id ?? null,
          assessedAt: assessment?.assessedAt ?? null,
          riskLevel: level,
          riskLabel: LEVEL_LABEL[level],
          basis: assessment?.basis ?? "insufficient",
          message: pickLang(protocol?.config.workerMessages[level], lang) ?? "",
          instructions,
          acknowledged: assessment ? acked.has(assessment.id) : false,
        };
      }),
    })),
  };
}

export async function acknowledgeInstructions(ctx, assessmentId) {
  requirePermission(ctx.actor, "worker.status");
  const [assessment] = await ctx.query(`SELECT * FROM assessments WHERE id = $1 AND org_id = $2`, [idOf(assessmentId, "Assessment"), ctx.actor.orgId]);
  if (!assessment) throw new NotFoundError("Assessment not found.");
  requireSite(ctx.actor, assessment.siteId);
  await ctx.query(
    `INSERT INTO instruction_acks (assessment_id, user_id, at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [assessment.id, ctx.actor.id, ctx.now()],
  );
  return { ok: true };
}

export async function submitReport(ctx, input) {
  requirePermission(ctx.actor, "worker.report");
  const site = await loadSite(ctx.query, ctx.actor, idOf(input.siteId, "Site"));
  const type = enumOf(input.type, Object.keys(REPORT_LABEL), "Report type");
  let crewId = null;
  if (input.crewId) {
    crewId = idOf(input.crewId, "Crew");
    const [crew] = await ctx.query(`SELECT id FROM crews WHERE id = $1 AND site_id = $2`, [crewId, site.id]);
    if (!crew) throw new ValidationError("That crew isn't at this site.");
  }
  const location = optionalText(input.location, 120);
  if (type === "someone_unwell" && !location) throw new ValidationError("Say where help is needed (e.g., work area or landmark).");
  const protocol = await activeProtocol(ctx.query, ctx.actor.orgId);
  if (!protocol) throw new ValidationError("No approved protocol is active. Tell your supervisor directly.");
  const controlId = type === "someone_unwell" ? "check_on_worker" : "fix_barrier";
  const note = optionalText(input.note, 300);
  const extra = `Reported: ${REPORT_LABEL[type]}${location ? ` — location: ${location}` : ""}${note ? ` — note: ${note}` : ""}`;
  const result = await withTx(async (query) => {
    const [actionId] = await createActionsForControls(query, ctx, {
      orgId: ctx.actor.orgId, siteId: site.id, crewId, assessmentId: null, cfg: protocol.config,
      controlIds: [controlId], source: "worker_report", extraInstructions: extra,
    });
    const [report] = await query(
      `INSERT INTO worker_reports (org_id, site_id, crew_id, type, location, note, action_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [ctx.actor.orgId, site.id, crewId, type, location, note, actionId, ctx.now()],
    );
    await audit(query, { ...ctx, actor: null }, { orgId: ctx.actor.orgId, action: "report.submitted", entityType: "worker_report", entityId: report.id, summary: `${REPORT_LABEL[type]} at ${site.name}` });
    await notifyRoles(query, ctx, ctx.actor.orgId, type === "someone_unwell" ? ["supervisor", "safety_lead"] : ["supervisor"], {
      kind: type === "someone_unwell" ? "urgent" : "report",
      siteId: site.id,
      title: `${REPORT_LABEL[type]} — ${site.name}`,
      body: location ? `Location: ${location}` : "See the action for details.",
      link: `/actions/${actionId}`,
    });
    return { reportId: report.id, actionId };
  });
  return {
    ...result,
    guidance: type === "someone_unwell"
      ? "Your supervisor has been alerted. If the person is confused, collapsed or not sweating, call emergency services now, move them to shade and cool them while you wait."
      : "Your report was sent without your name. A supervisor will follow it up.",
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value * 10) / 10;
}
function pct(part, total) {
  return total ? Math.round((part / total) * 1000) / 10 : null;
}

export async function insightsSummary(ctx, daysInput, siteId) {
  requirePermission(ctx.actor, "insights.view");
  const days = [7, 28, 90].includes(Number(daysInput)) ? Number(daysInput) : 28;
  const now = ctx.now();
  const from = new Date(now.getTime() - days * 864e5);
  let sites = await ctx.query(`SELECT id, name FROM sites WHERE org_id = $1`, [ctx.actor.orgId]);
  if (SITE_SCOPED.has(ctx.actor.role)) sites = sites.filter((site) => ctx.actor.siteIds.includes(site.id));
  if (siteId) sites = sites.filter((site) => site.id === idOf(siteId, "Site"));
  if (!sites.length) return emptyInsights(days, now);
  const ids = sites.map((site) => site.id);
  const assessments = await ctx.query(
    `SELECT site_id, assessed_at, risk_level, basis, data_issues FROM assessments WHERE site_id = ANY($1::uuid[]) AND assessed_at >= $2`,
    [ids, from],
  );
  const actions = await ctx.query(
    `SELECT site_id, created_at, ack_due_at, due_at, acknowledged_at, completed_at, status, escalation_level, barrier, priority, source, title, control_id
     FROM actions WHERE site_id = ANY($1::uuid[]) AND created_at >= $2`,
    [ids, from],
  );
  const minutes = (start, end) => (end.getTime() - start.getTime()) / 60000;
  const summarize = (actionRows, assessmentRows) => {
    const acked = actionRows.filter((row) => row.acknowledgedAt);
    const due = actionRows.filter((row) => row.status !== "cancelled" && (row.status === "completed" || row.dueAt < now));
    const onTime = due.filter((row) => row.status === "completed" && row.completedAt && row.completedAt <= row.dueAt);
    const late = due.filter((row) => (row.status === "completed" ? row.completedAt > row.dueAt : row.dueAt < now));
    return {
      assessments: assessmentRows.length,
      highOrExtreme: assessmentRows.filter((row) => row.riskLevel === "high" || row.riskLevel === "extreme").length,
      unknown: assessmentRows.filter((row) => row.riskLevel === "unknown").length,
      validDataPct: pct(assessmentRows.filter((row) => row.basis !== "insufficient").length, assessmentRows.length),
      measuredPct: pct(assessmentRows.filter((row) => row.basis === "measured").length, assessmentRows.length),
      actions: actionRows.length,
      medianAckMinutes: median(acked.map((row) => minutes(row.createdAt, row.acknowledgedAt))),
      ackOnTimePct: pct(acked.filter((row) => row.acknowledgedAt <= row.ackDueAt).length, actionRows.length),
      completedOnTimePct: pct(onTime.length, due.length),
      overdue: late.length,
      escalated: actionRows.filter((row) => row.escalationLevel > 0).length,
      escalatedL2: actionRows.filter((row) => row.escalationLevel > 1).length,
      blocked: actionRows.filter((row) => row.barrier).length,
      workerReports: actionRows.filter((row) => row.source === "worker_report").length,
    };
  };
  const perSite = sites.map((site) => ({
    siteId: site.id,
    siteName: site.name,
    ...summarize(actions.filter((row) => row.siteId === site.id), assessments.filter((row) => row.siteId === site.id)),
  }));
  const barriers = BARRIERS.map((barrier) => ({
    id: barrier.id,
    label: barrier.label,
    count: actions.filter((row) => row.barrier === barrier.id).length,
  })).filter((barrier) => barrier.count > 0);
  const controls = new Map();
  for (const action of actions.filter((row) => row.status !== "cancelled")) {
    const current = controls.get(action.controlId) ?? { title: action.title, total: 0, late: 0 };
    current.total += 1;
    if ((action.status === "completed" && action.completedAt > action.dueAt) || (action.status !== "completed" && action.dueAt < now)) current.late += 1;
    controls.set(action.controlId, current);
  }
  const lateControls = [...controls.entries()]
    .map(([controlId, value]) => ({ controlId, title: value.title, total: value.total, late: value.late, latePct: pct(value.late, value.total) }))
    .filter((row) => row.late > 0)
    .sort((a, b) => b.late - a.late)
    .slice(0, 6);
  const trend = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(now.getTime() - offset * 864e5).toISOString().slice(0, 10);
    const dayAssessments = assessments.filter((row) => row.assessedAt.toISOString().slice(0, 10) === day);
    const dayActions = actions.filter((row) => row.createdAt.toISOString().slice(0, 10) === day && row.status !== "cancelled" && (row.status === "completed" || row.dueAt < now));
    trend.push({
      day,
      assessments: dayAssessments.length,
      highOrExtreme: dayAssessments.filter((row) => row.riskLevel === "high" || row.riskLevel === "extreme").length,
      completedOnTimePct: pct(dayActions.filter((row) => row.status === "completed" && row.completedAt <= row.dueAt).length, dayActions.length),
    });
  }
  return {
    days,
    generatedAt: now.toISOString(),
    overall: summarize(actions, assessments),
    perSite,
    barriers,
    lateControls,
    trend,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hourUtc: hour,
      count: assessments.filter((row) => (row.riskLevel === "high" || row.riskLevel === "extreme") && row.assessedAt.getUTCHours() === hour).length,
    })),
  };
}

function emptyInsights(days, now) {
  return { days, generatedAt: now.toISOString(), overall: null, perSite: [], barriers: [], lateControls: [], trend: [], hours: [] };
}

export function insightsCsv(summary) {
  const cell = (value) => {
    let textValue = value == null ? "" : String(value);
    if (/^[=+\-@]/.test(textValue)) textValue = `'${textValue}`;
    return /[",\n]/.test(textValue) ? `"${textValue.replaceAll('"', '""')}"` : textValue;
  };
  const columns = ["siteName", "assessments", "highOrExtreme", "unknown", "validDataPct", "measuredPct", "actions", "medianAckMinutes", "ackOnTimePct", "completedOnTimePct", "overdue", "escalated", "escalatedL2", "blocked", "workerReports"];
  return [
    `HeatShield Shift site-level report,last ${summary.days} days,generated ${summary.generatedAt}`,
    "Aggregated operational data only. No individual records.",
    columns.join(","),
    ...summary.perSite.map((site) => columns.map((column) => cell(site[column])).join(",")),
    "",
    "Barrier,Count",
    ...summary.barriers.map((barrier) => `${cell(barrier.label)},${barrier.count}`),
  ].join("\n");
}

export async function listAudit(ctx, filters) {
  requirePermission(ctx.actor, "audit.view");
  const params = [ctx.actor.orgId];
  const where = ["a.org_id = $1"];
  if (filters.entityType) {
    params.push(filters.entityType);
    where.push(`a.entity_type = $${params.length}`);
  }
  if (filters.action) {
    params.push(`${String(filters.action).replace(/[%_]/g, "")}%`);
    where.push(`a.action LIKE $${params.length}`);
  }
  if (filters.from) {
    params.push(new Date(filters.from));
    where.push(`a.at >= $${params.length}`);
  }
  if (filters.to) {
    params.push(new Date(filters.to));
    where.push(`a.at <= $${params.length}`);
  }
  if (filters.before) {
    params.push(filters.before);
    where.push(`a.id < $${params.length}::bigint`);
  }
  return ctx.query(
    `SELECT a.id::text AS id, a.at, a.actor_id, a.actor_role, a.action, a.entity_type, a.entity_id, a.summary, a.meta,
            COALESCE(u.role_label, CASE WHEN a.actor_role = 'system' THEN 'System' ELSE '—' END) AS actor_label
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     WHERE ${where.join(" AND ")} ORDER BY a.id DESC LIMIT 100`,
    params,
  );
}

export async function listNotifications(ctx) {
  if (!ctx.actor) throw new AuthnError();
  const items = await ctx.query(
    `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [ctx.actor.id],
  );
  const [{ n }] = await ctx.query(
    `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [ctx.actor.id],
  );
  return { items, unread: n };
}

export async function markNotificationsRead(ctx) {
  if (!ctx.actor) throw new AuthnError();
  await ctx.query(`UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL`, [ctx.actor.id, ctx.now()]);
  return { ok: true };
}

async function checkSites(ctx, siteIds) {
  if (!siteIds.length) return;
  const rows = await ctx.query(`SELECT id FROM sites WHERE org_id = $1 AND id = ANY($2::uuid[])`, [ctx.actor.orgId, siteIds]);
  if (rows.length !== new Set(siteIds).size) throw new ValidationError("One or more sites don't exist.");
}
function checkScope(role, siteIds) {
  if ((role === "supervisor" || role === "worker") && !siteIds.length) {
    throw new ValidationError(`A ${roleLabel(role)} must be assigned to at least one site.`);
  }
}

export async function listUsers(ctx) {
  requirePermission(ctx.actor, "users.manage");
  const users = await ctx.query(
    `SELECT id, login_id, role_label, role, active, must_change_password, locked_until, last_login_at, language
     FROM users WHERE org_id = $1 ORDER BY role, login_id`,
    [ctx.actor.orgId],
  );
  const links = users.length
    ? await ctx.query(`SELECT user_id, site_id FROM user_sites WHERE user_id = ANY($1::uuid[])`, [users.map((user) => user.id)])
    : [];
  return users.map((user) => ({ ...user, siteIds: links.filter((link) => link.userId === user.id).map((link) => link.siteId) }));
}

export async function createUser(ctx, input) {
  requirePermission(ctx.actor, "users.manage");
  const loginId = text(input.loginId, 120, "Login ID").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginId) && !/^[a-z0-9._-]{3,64}$/.test(loginId)) {
    throw new ValidationError("Use an email address or a short login ID.");
  }
  const role = enumOf(input.role, ROLES.map((item) => item.id), "Role");
  const siteIds = Array.isArray(input.siteIds) ? input.siteIds.map((siteId) => idOf(siteId, "Site")) : [];
  checkScope(role, siteIds);
  await checkSites(ctx, siteIds);
  const [existing] = await ctx.query(`SELECT id FROM users WHERE login_id = $1`, [loginId]);
  if (existing) throw new ConflictError("That login ID is already in use.");
  const temporary = tempPassword();
  const passwordHash = await hashPassword(temporary);
  const id = await withTx(async (query) => {
    const [user] = await query(
      `INSERT INTO users (org_id, login_id, role, role_label, language, password_hash, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
      [ctx.actor.orgId, loginId, role, text(input.roleLabel, 80, "Role label"), enumOf(input.language ?? "en", ["en", "hi", "ar"], "Language"), passwordHash],
    );
    if (siteIds.length) {
      const params = [];
      const values = siteIds.map((siteId, index) => {
        params.push(user.id, siteId);
        return `($${index * 2 + 1}, $${index * 2 + 2})`;
      });
      await query(`INSERT INTO user_sites (user_id, site_id) VALUES ${values.join(", ")}`, params);
    }
    await audit(query, ctx, { action: "user.created", entityType: "user", entityId: user.id, summary: `Created ${roleLabel(role)} account ${loginId}`, meta: { role, siteIds } });
    return user.id;
  });
  return { id, temporaryPassword: temporary };
}

export async function updateUser(ctx, userId, input) {
  requirePermission(ctx.actor, "users.manage");
  const [user] = await ctx.query(`SELECT * FROM users WHERE id = $1 AND org_id = $2`, [idOf(userId, "User"), ctx.actor.orgId]);
  if (!user) throw new NotFoundError("User not found.");
  const role = input.role ? enumOf(input.role, ROLES.map((item) => item.id), "Role") : user.role;
  const active = input.active == null ? user.active : Boolean(input.active);
  if (user.role === "org_admin" && (role !== "org_admin" || active === false)) {
    const [{ n }] = await ctx.query(
      `SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND role = 'org_admin' AND active = true AND id <> $2`,
      [ctx.actor.orgId, user.id],
    );
    if (n === 0) throw new ConflictError("Keep at least one active Organization Admin.");
  }
  if (user.id === ctx.actor.id && (active === false || (input.role && input.role !== user.role))) {
    throw new ConflictError("You can't deactivate your own account or change your own role.");
  }
  const currentSites = (await ctx.query(`SELECT site_id FROM user_sites WHERE user_id = $1`, [user.id])).map((row) => row.siteId);
  const siteIds = Array.isArray(input.siteIds) ? input.siteIds.map((siteId) => idOf(siteId, "Site")) : currentSites;
  checkScope(role, siteIds);
  await checkSites(ctx, siteIds);
  await withTx(async (query) => {
    await query(`UPDATE users SET role = $2, role_label = $3, active = $4, language = $5 WHERE id = $1`, [
      user.id, role, input.roleLabel ? text(input.roleLabel, 80, "Role label") : user.roleLabel, active, enumOf(input.language ?? user.language, ["en", "hi", "ar"], "Language"),
    ]);
    if (Array.isArray(input.siteIds)) {
      await query(`DELETE FROM user_sites WHERE user_id = $1`, [user.id]);
      if (siteIds.length) {
        const params = [];
        const values = siteIds.map((siteId, index) => {
          params.push(user.id, siteId);
          return `($${index * 2 + 1}, $${index * 2 + 2})`;
        });
        await query(`INSERT INTO user_sites (user_id, site_id) VALUES ${values.join(", ")}`, params);
      }
    }
    if (input.role || input.active === false || Array.isArray(input.siteIds)) {
      await query(`DELETE FROM sessions WHERE user_id = $1`, [user.id]);
    }
    await audit(query, ctx, {
      action: "user.updated",
      entityType: "user",
      entityId: user.id,
      summary: `Updated ${user.loginId}`,
      meta: { from: { role: user.role, active: user.active, siteIds: currentSites }, to: { role, active, siteIds } },
    });
  });
  return { ok: true };
}

export async function resetPassword(ctx, userId) {
  requirePermission(ctx.actor, "users.manage");
  const [user] = await ctx.query(`SELECT * FROM users WHERE id = $1 AND org_id = $2`, [idOf(userId, "User"), ctx.actor.orgId]);
  if (!user) throw new NotFoundError("User not found.");
  const temporary = tempPassword();
  const passwordHash = await hashPassword(temporary);
  await withTx(async (query) => {
    await query(
      `UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL WHERE id = $1`,
      [user.id, passwordHash],
    );
    await query(`DELETE FROM sessions WHERE user_id = $1`, [user.id]);
    await audit(query, ctx, { action: "user.password_reset", entityType: "user", entityId: user.id, summary: `Reset password for ${user.loginId}` });
  });
  return { temporaryPassword: temporary };
}

export async function getSettings(ctx) {
  requirePermission(ctx.actor, "settings.manage");
  const [org] = await ctx.query(`SELECT * FROM organizations WHERE id = $1`, [ctx.actor.orgId]);
  return { name: org.name, timezone: org.timezone, retentionDays: { ...DEFAULT_RETENTION, ...(org.settings.retentionDays ?? {}) } };
}

export async function updateSettings(ctx, input) {
  requirePermission(ctx.actor, "settings.manage");
  checkZone(String(input.timezone ?? ""));
  const retention = input.retentionDays ?? {};
  const days = {
    actions: Number(retention.actions),
    readings: Number(retention.readings),
    sessions: Number(retention.sessions),
    notifications: Number(retention.notifications),
  };
  if (!Number.isInteger(days.actions) || days.actions < 365) throw new ValidationError("Keep safety action records for at least 365 days.");
  if (days.readings < 30 || days.notifications < 7 || days.sessions < 1) throw new ValidationError("Retention periods are below the minimum.");
  const [org] = await ctx.query(`SELECT settings FROM organizations WHERE id = $1`, [ctx.actor.orgId]);
  await ctx.query(`UPDATE organizations SET name = $2, timezone = $3, settings = $4::jsonb WHERE id = $1`, [
    ctx.actor.orgId, text(input.name, 160, "Organization name"), input.timezone, JSON.stringify({ ...org.settings, retentionDays: days }),
  ]);
  await audit(ctx.query, ctx, { action: "settings.updated", entityType: "organization", entityId: ctx.actor.orgId, summary: "Updated organization settings", meta: { retentionDays: days } });
  return { ok: true };
}

export async function sweepRetention(query, now) {
  const orgs = await query(`SELECT id, settings FROM organizations`);
  for (const org of orgs) {
    const retention = { ...DEFAULT_RETENTION, ...(org.settings?.retentionDays ?? {}) };
    await query(
      `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE org_id = $1) AND (expires_at < $2 OR created_at < $3)`,
      [org.id, now, new Date(now.getTime() - retention.sessions * 864e5)],
    );
    await query(`DELETE FROM notifications WHERE org_id = $1 AND created_at < $2`, [org.id, new Date(now.getTime() - retention.notifications * 864e5)]);
    await query(`DELETE FROM readings WHERE org_id = $1 AND observed_at < $2`, [org.id, new Date(now.getTime() - retention.readings * 864e5)]);
    await query(
      `UPDATE worker_reports SET action_id = NULL WHERE action_id IN (
         SELECT id FROM actions WHERE org_id = $1 AND status IN ('completed','cancelled') AND created_at < $2
       )`,
      [org.id, new Date(now.getTime() - retention.actions * 864e5)],
    );
    await query(
      `DELETE FROM actions WHERE org_id = $1 AND status IN ('completed','cancelled') AND created_at < $2`,
      [org.id, new Date(now.getTime() - retention.actions * 864e5)],
    );
  }
  await query(`DELETE FROM login_attempts WHERE at < $1`, [new Date(now.getTime() - 864e5)]);
}
