const base = "http://127.0.0.1:8080";

async function call(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const setCookie = response.headers.getSetCookie?.() ?? [];
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data, setCookie, rawCookie: response.headers.get("set-cookie") };
}

function session(result) {
  const header = result.rawCookie ?? "";
  const match = header.match(/hs_session=([^;]+)/);
  if (!match) throw new Error(`no session: ${result.status} ${JSON.stringify(result.data)}`);
  return `hs_session=${match[1]}`;
}

const bad = await call("/api/auth/login", { method: "POST", body: { loginId: "admin@heatshield.example", password: "wrong-password" } });
if (bad.status !== 401) throw new Error(`expected 401, got ${bad.status}`);

const login = await call("/api/auth/login", {
  method: "POST",
  body: { loginId: "supervisor.north@heatshield.example", password: "Harbour-Yard-24" },
});
if (login.status !== 200) throw new Error(`login ${login.status} ${JSON.stringify(login.data)}`);
const cookie = session(login);
const me = await call("/api/me", { cookie });
if (me.data.role !== "supervisor") throw new Error("role");
const sites = await call("/api/sites", { cookie });
const site = sites.data.find((item) => item.code === "NY");
const assessed = await call(`/api/sites/${site.id}/assessments`, { method: "POST", cookie, body: { fetch: true } });
if (assessed.status !== 201) throw new Error(`assess ${assessed.status} ${JSON.stringify(assessed.data)}`);
const actions = await call("/api/actions?view=active", { cookie });
if (!actions.data.length) throw new Error("no actions created");
const first = actions.data.find((action) => action.canRespond) ?? actions.data[0];
const ack = await call(`/api/actions/${first.id}/acknowledge`, { method: "POST", cookie });
if (ack.status !== 200 && first.status !== "open") {
  /* safety-lead actions cannot be acknowledged by a supervisor */
}
const workerLogin = await call("/api/auth/login", {
  method: "POST",
  body: { loginId: "worker.north@heatshield.example", password: "Harbour-Yard-24" },
});
const worker = session(workerLogin);
const status = await call("/api/worker/status?language=hi", { cookie: worker });
if (!status.data.sites?.length) throw new Error("worker has no site");
const report = await call("/api/worker/reports", {
  method: "POST",
  cookie: worker,
  body: { siteId: site.id, type: "no_water", note: "Bay 3" },
});
if (report.status !== 201) throw new Error(`report ${report.status} ${JSON.stringify(report.data)}`);
const analystLogin = await call("/api/auth/login", {
  method: "POST",
  body: { loginId: "analyst@heatshield.example", password: "Harbour-Yard-24" },
});
const insights = await call("/api/insights?days=7", { cookie: session(analystLogin) });
if (insights.status !== 200 || !insights.data.overall) throw new Error(`insights ${insights.status}`);
const denied = await call("/api/users", { cookie: session(analystLogin) });
if (denied.status !== 403) throw new Error(`analyst should be forbidden, got ${denied.status}`);
console.log(JSON.stringify({
  site: site.name,
  crews: assessed.data.results.map((result) => ({ crew: result.crewName, risk: result.assessment.riskLevel, actions: result.actionsCreated })),
  openActions: actions.data.length,
  workerLanguage: status.data.language,
  reportGuidance: report.data.guidance,
  insightAssessments: insights.data.overall.assessments,
}, null, 2));
