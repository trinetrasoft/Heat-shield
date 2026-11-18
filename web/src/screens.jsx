import { useEffect, useState } from "react";
import { api } from "./api.js";
import { BarChart, DonutChart, HorizontalBars, LineChart, Meter, basisItems, priorityItems, riskItems, statusItems } from "./charts.jsx";
import { RiskBadge, run, useLoad, when } from "./ui.jsx";

const INTENSITY = [["light", "Light"], ["moderate", "Moderate"], ["heavy", "Heavy"], ["very_heavy", "Very heavy"]];
const CLOTHING = [["standard", "Standard work clothes"], ["coveralls", "Cloth coveralls"], ["double_layer", "Double layer"], ["vapour_barrier", "Vapour barrier"]];
const ACCLIM = [["acclimatized", "Acclimatized"], ["mixed", "Partly acclimatized"], ["new_workers", "New or returning workers"]];
const BARRIERS = [["no_water", "No drinking water available"], ["no_shade", "No shade available"], ["no_rest_area", "No cool rest area"], ["no_authority", "No authority to change the schedule"], ["staffing", "Not enough staff to rotate"], ["equipment", "Equipment or instrument unavailable"], ["other", "Other"]];
const REPORTS = [["no_water", "No drinking water"], ["no_shade", "No shade"], ["no_rest_area", "No cool rest area"], ["someone_unwell", "Someone may be unwell"], ["other", "Other safety concern"]];

function Page({ title, lede, children, actions }) {
  return (
    <div className="grid">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div><h1>{title}</h1>{lede && <p className="muted">{lede}</p>}</div>
        <div className="row">{actions}</div>
      </div>
      {children}
    </div>
  );
}

export function Dashboard({ go }) {
  const { data, error, loading } = useLoad(() => api("/api/dashboard"), []);
  if (loading) return <p>Loading the shift picture…</p>;
  if (error) return <div className="banner danger">{error}</div>;
  const onTrack = Math.max(0, data.openActions - data.overdue);
  return (
    <Page title="This shift" lede="Open protective actions and crews at high, extreme, or unknown risk in the last 12 hours.">
      {data.protocol?.exampleOnly && <div className="banner">Protocol v{data.protocol.version} still uses illustrative thresholds. A Safety Lead should replace them before operational reliance.</div>}
      {!data.protocol && <div className="banner danger">No approved protocol. Assessments cannot run until a Safety Lead approves one.</div>}
      <div className="grid stats">
        <article className="card stat"><span className="muted">Open actions</span><b>{data.openActions}</b><Meter label="On track" value={data.openActions ? Math.round((onTrack / data.openActions) * 100) : 100} color="#176b45" /></article>
        <article className="card stat"><span className="muted">Overdue</span><b>{data.overdue}</b><Meter label="Of open actions" value={data.openActions ? Math.round((data.overdue / data.openActions) * 100) : 0} color="#9f2d2d" /></article>
        <article className="card stat"><span className="muted">Escalated</span><b>{data.escalated}</b><span className="muted">{data.ackOverdue ?? 0} waiting on acknowledgement</span></article>
        <article className="card stat"><span className="muted">Awaiting approval</span><b>{data.pendingApprovals}</b><span className="muted">{data.protocol ? `Protocol v${data.protocol.version}` : "No active protocol"}</span></article>
      </div>
      <div className="grid chart-grid">
        <article className="card"><DonutChart title="Action status" items={statusItems(data.statusCounts)} centerLabel="open" centerValue={data.openActions} /></article>
        <article className="card"><DonutChart title="Priority mix" items={priorityItems(data.priorityCounts)} centerLabel="actions" /></article>
        <article className="card"><DonutChart title="Latest crew risk" items={riskItems(data.riskMix)} centerLabel="crews" /></article>
        <article className="card"><DonutChart title="Assessment basis" items={basisItems(data.basisMix)} centerLabel="crews" /></article>
      </div>
      <div className="split">
        <article className="card">
          <BarChart
            title="Activity in the last 12 hours"
            series={(data.trend ?? []).map((point) => ({ label: point.hour, assessments: point.assessments, actions: point.actions }))}
            colors={["#0f6e6b", "#c45c12"]}
          />
        </article>
        <article className="card">
          <HorizontalBars
            title="Open actions by site"
            valueLabel="open"
            items={(data.siteLoad ?? []).map((site) => ({
              id: site.siteId,
              label: site.siteName,
              value: site.openActions,
              meta: `${site.overdue} overdue`,
              color: site.overdue ? "#9f2d2d" : "#0f6e6b",
            }))}
          />
          {(data.siteLoad ?? []).length > 0 && (
            <div className="row" style={{ marginTop: 10 }}>
              {(data.siteLoad ?? []).slice(0, 3).map((site) => (
                <button key={site.siteId} className="btn-secondary" onClick={() => go(`/sites/${site.siteId}`)}>{site.siteName}</button>
              ))}
            </div>
          )}
        </article>
      </div>
      <div>
        <h2>Crews needing attention</h2>
        <div className="grid cards">
          {data.hotCrews.length === 0 && <article className="card">No crews are currently in a high, extreme, or unknown band.</article>}
          {data.hotCrews.map((crew) => (
            <button key={`${crew.siteId}-${crew.crewName}`} className="card hot-crew" onClick={() => go(`/sites/${crew.siteId}`)}>
              <RiskBadge level={crew.riskLevel} />
              <h2 style={{ marginTop: 8 }}>{crew.crewName}</h2>
              <p className="muted">{crew.siteName} · {crew.basis} · {when(crew.assessedAt)}</p>
              <div className={`risk-strip risk-${crew.riskLevel}`} />
            </button>
          ))}
        </div>
      </div>
    </Page>
  );
}

export function SitesPage({ go, me, toast }) {
  const { data, error, loading, reload } = useLoad(() => api("/api/sites"), []);
  const [open, setOpen] = useState(false);
  return (
    <Page title="Sites" lede="Each site carries facilities, crews, and the readings used for assessment." actions={me.permissions.includes("sites.manage") && <button className="btn" onClick={() => setOpen(true)}>Add site</button>}>
      {loading && <p>Loading sites…</p>}
      {error && <div className="banner danger">{error}</div>}
      <div className="grid cards">
        {data?.map((site) => (
          <button key={site.id} className="card" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => go(`/sites/${site.id}`)}>
            <div className="row" style={{ justifyContent: "space-between" }}><strong>{site.name}</strong><span className="muted">{site.code}</span></div>
            <p className="muted">{site.crewCount} active crews · {site.openActions} open actions</p>
            <div className="row">{site.latestAssessments.map((item) => <RiskBadge key={item.id} level={item.riskLevel} />)}</div>
          </button>
        ))}
      </div>
      {open && <SiteForm toast={toast} onDone={() => { setOpen(false); reload(); }} onClose={() => setOpen(false)} />}
    </Page>
  );
}

function SiteForm({ initial, toast, onDone, onClose }) {
  const site = initial ?? { name: "", code: "", latitude: "", longitude: "", timezone: "Asia/Dubai", environment: "outdoor", hasWbgtInstrument: false, facilities: { drinkingWater: true, shade: true, coolRestArea: false, notes: "" } };
  const [form, setForm] = useState(site);
  const setFac = (key, value) => setForm({ ...form, facilities: { ...form.facilities, [key]: value } });
  return (
    <form className="card grid" onSubmit={(event) => {
      event.preventDefault();
      const body = { ...form, latitude: Number(form.latitude), longitude: Number(form.longitude) };
      run(() => api(initial ? `/api/sites/${initial.id}` : "/api/sites", { method: initial ? "PATCH" : "POST", body }), () => { toast(initial ? "Site updated." : "Site created."); onDone(); }, toast);
    }}>
      <h2>{initial ? "Edit site" : "New site"}</h2>
      <div className="grid" style={{ gridTemplateColumns: "1fr 140px" }}>
        <label className="field">Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label>
        <label className="field">Code<input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} required /></label>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
        <label className="field">Latitude<input value={form.latitude} onChange={(event) => setForm({ ...form, latitude: event.target.value })} required /></label>
        <label className="field">Longitude<input value={form.longitude} onChange={(event) => setForm({ ...form, longitude: event.target.value })} required /></label>
        <label className="field">Time zone<input value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} required /></label>
      </div>
      <label className="field">Environment
        <select value={form.environment} onChange={(event) => setForm({ ...form, environment: event.target.value })}>
          <option value="outdoor">Outdoor</option><option value="mixed">Mixed</option><option value="indoor">Indoor</option>
        </select>
      </label>
      <div className="row">
        <label><input type="checkbox" checked={form.facilities.drinkingWater} onChange={(event) => setFac("drinkingWater", event.target.checked)} /> Drinking water</label>
        <label><input type="checkbox" checked={form.facilities.shade} onChange={(event) => setFac("shade", event.target.checked)} /> Shade</label>
        <label><input type="checkbox" checked={form.facilities.coolRestArea} onChange={(event) => setFac("coolRestArea", event.target.checked)} /> Cool rest area</label>
        <label><input type="checkbox" checked={form.hasWbgtInstrument} onChange={(event) => setForm({ ...form, hasWbgtInstrument: event.target.checked })} /> WBGT instrument</label>
      </div>
      <label className="field">Facility notes<textarea rows={2} value={form.facilities.notes ?? ""} onChange={(event) => setFac("notes", event.target.value)} /></label>
      <div className="row"><button className="btn">Save site</button><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button></div>
    </form>
  );
}

export function SitePage({ id, go, me, toast }) {
  const { data, error, loading, reload } = useLoad(() => api(`/api/sites/${id}`), [id]);
  const forecast = useLoad(() => api(`/api/sites/${id}/forecast`).catch(() => []), [id]);
  const [editing, setEditing] = useState(false);
  const [reading, setReading] = useState({ source: "onsite_wbgt", wbgtC: "", airTempC: "", relativeHumidity: "", notes: "" });
  if (loading) return <p>Loading site…</p>;
  if (error) return <div className="banner danger">{error}</div>;
  const { site, crews, readings, latestAssessments } = data;
  const canRun = me.permissions.includes("assessments.run");
  const canManage = me.permissions.includes("sites.manage");
  const canConditions = me.permissions.includes("crews.conditions");
  return (
    <Page title={site.name} lede={`${site.code} · ${site.environment} · ${site.timezone}`} actions={
      <>
        <button className="btn-secondary" onClick={() => go("/sites")}>All sites</button>
        {canManage && <button className="btn-secondary" onClick={() => setEditing((value) => !value)}>Edit site</button>}
        {canRun && <button className="btn-secondary" onClick={() => run(() => api(`/api/sites/${id}/weather`, { method: "POST" }), () => { toast("Weather fetched."); reload(); forecast.reload(); }, toast)}>Fetch weather</button>}
        {canRun && <button className="btn" onClick={() => run(() => api(`/api/sites/${id}/assessments`, { method: "POST", body: { fetch: true } }), (result) => { toast(`Assessed ${result.results.length} crew(s).`); reload(); }, toast)}>Run assessment</button>}
      </>
    }>
      {editing && <SiteForm initial={site} toast={toast} onDone={() => { setEditing(false); reload(); }} onClose={() => setEditing(false)} />}
      <div className="row">
        <span className="badge">{site.facilities.drinkingWater ? "Water on site" : "No drinking water"}</span>
        <span className="badge">{site.facilities.shade ? "Shade" : "No shade"}</span>
        <span className="badge">{site.facilities.coolRestArea ? "Cool rest area" : "No cool rest area"}</span>
        {site.hasWbgtInstrument && <span className="badge">WBGT instrument</span>}
      </div>
      {site.facilities.notes && <p className="muted">{site.facilities.notes}</p>}
      <div className="split">
        <div className="grid">
          {crews.map((crew) => {
            const latest = latestAssessments.find((item) => item.crewId === crew.id);
            return (
              <article key={crew.id} className="card">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <h2>{crew.name}</h2>
                  {latest ? <RiskBadge level={latest.riskLevel} /> : <span className="muted">Not assessed</span>}
                </div>
                <p className="muted">{crew.workArea} · {crew.shiftStart}–{crew.shiftEnd} · {crew.active ? "Active" : "Inactive"}</p>
                {latest && <p>{latest.reasons?.[0]}</p>}
                {canConditions && crew.active && <ConditionsForm crew={crew} toast={toast} onDone={reload} />}
              </article>
            );
          })}
          {canManage && <CrewForm siteId={id} toast={toast} onDone={reload} />}
        </div>
        <div className="grid">
          {canRun && (
            <form className="card grid" onSubmit={(event) => {
              event.preventDefault();
              run(() => api(`/api/sites/${id}/readings`, { method: "POST", body: reading }), () => { toast("Reading recorded."); reload(); }, toast);
            }}>
              <h2>Record a reading</h2>
              <label className="field">Source
                <select value={reading.source} onChange={(event) => setReading({ ...reading, source: event.target.value })}>
                  <option value="onsite_wbgt">On-site WBGT</option>
                  <option value="manual">Manual entry</option>
                </select>
              </label>
              <label className="field">WBGT °C<input value={reading.wbgtC} onChange={(event) => setReading({ ...reading, wbgtC: event.target.value })} /></label>
              <label className="field">Air temperature °C<input value={reading.airTempC} onChange={(event) => setReading({ ...reading, airTempC: event.target.value })} /></label>
              <label className="field">Relative humidity %<input value={reading.relativeHumidity} onChange={(event) => setReading({ ...reading, relativeHumidity: event.target.value })} /></label>
              <label className="field">Notes<input value={reading.notes} onChange={(event) => setReading({ ...reading, notes: event.target.value })} /></label>
              <button className="btn">Save reading</button>
            </form>
          )}
          <article className="card">
            <h2>Recent readings</h2>
            {readings.length === 0 && <p className="muted">None yet.</p>}
            {readings.map((item) => <p key={item.id}>{when(item.observedAt)} · {item.source} · {item.wbgtC != null ? `WBGT ${item.wbgtC} °C` : `${item.airTempC} °C / ${item.relativeHumidity}%`}</p>)}
          </article>
          <article className="card">
            <h2>Forecast</h2>
            {forecast.data?.length ? forecast.data.slice(0, 8).map((item) => <p key={item.id}>{when(item.observedAt)} · {item.airTempC} °C · HI {item.heatIndexC} °C</p>) : <p className="muted">Fetch weather to fill the next 12 hours.</p>}
          </article>
        </div>
      </div>
    </Page>
  );
}

function ConditionsForm({ crew, toast, onDone }) {
  const [form, setForm] = useState({ taskIntensity: crew.taskIntensity, clothing: crew.clothing, acclimatization: crew.acclimatization });
  return (
    <form className="grid" onSubmit={(event) => {
      event.preventDefault();
      run(() => api(`/api/crews/${crew.id}/conditions`, { method: "PATCH", body: form }), () => { toast("Crew conditions updated."); onDone(); }, toast);
    }}>
      <Select label="Intensity" value={form.taskIntensity} options={INTENSITY} onChange={(taskIntensity) => setForm({ ...form, taskIntensity })} />
      <Select label="Clothing" value={form.clothing} options={CLOTHING} onChange={(clothing) => setForm({ ...form, clothing })} />
      <Select label="Acclimatization" value={form.acclimatization} options={ACCLIM} onChange={(acclimatization) => setForm({ ...form, acclimatization })} />
      <button className="btn-secondary">Update conditions</button>
    </form>
  );
}

function CrewForm({ siteId, toast, onDone }) {
  const [form, setForm] = useState({ name: "", workArea: "", taskIntensity: "moderate", clothing: "standard", acclimatization: "acclimatized", shiftStart: "06:00", shiftEnd: "14:00" });
  return (
    <form className="card grid" onSubmit={(event) => {
      event.preventDefault();
      run(() => api("/api/crews", { method: "POST", body: { ...form, siteId } }), () => { toast("Crew added."); onDone(); }, toast);
    }}>
      <h2>Add a crew</h2>
      <label className="field">Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label>
      <label className="field">Work area<input value={form.workArea} onChange={(event) => setForm({ ...form, workArea: event.target.value })} required /></label>
      <div className="row">
        <label className="field">Start<input value={form.shiftStart} onChange={(event) => setForm({ ...form, shiftStart: event.target.value })} required /></label>
        <label className="field">End<input value={form.shiftEnd} onChange={(event) => setForm({ ...form, shiftEnd: event.target.value })} required /></label>
      </div>
      <button className="btn">Save crew</button>
    </form>
  );
}

function Select({ label, value, options, onChange }) {
  return <label className="field">{label}<select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>;
}

export function ActionsPage({ go, me, toast }) {
  const [view, setView] = useState("active");
  const { data, error, loading, reload } = useLoad(() => api(`/api/actions?view=${view}`), [view]);
  const [open, setOpen] = useState(false);
  return (
    <Page title="Protective actions" lede="Acknowledge, complete, or escalate. A blocked action needs a reason." actions={
      <>
        <select value={view} onChange={(event) => setView(event.target.value)} aria-label="Filter actions">
          <option value="active">Active</option><option value="escalated">Escalated</option><option value="closed">Closed</option>
        </select>
        {me.permissions.includes("actions.create") && <button className="btn" onClick={() => setOpen(true)}>New action</button>}
        {me.permissions.includes("escalations.run") && <button className="btn-secondary" onClick={() => run(() => api("/api/escalations/run", { method: "POST" }), (result) => { toast(`Escalated ${result.level1 + result.level2}.`); reload(); }, toast)}>Run escalations</button>}
      </>
    }>
      {loading && <p>Loading actions…</p>}
      {error && <div className="banner danger">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Priority</th><th>Action</th><th>Site</th><th>Due</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {data?.map((action) => (
              <tr key={action.id}>
                <td>{action.priority}{action.escalationLevel > 0 ? ` · L${action.escalationLevel}` : ""}</td>
                <td>{action.title}<div className="muted">{action.crewName}</div></td>
                <td>{action.siteName}</td>
                <td>{when(action.dueAt)}{action.overdue ? " · overdue" : ""}</td>
                <td>{action.status}</td>
                <td><button className="btn-secondary" onClick={() => go(`/actions/${action.id}`)}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data?.length === 0 && <p className="muted">Nothing in this view.</p>}
      {open && <ManualAction toast={toast} onDone={() => { setOpen(false); reload(); }} onClose={() => setOpen(false)} />}
    </Page>
  );
}

function ManualAction({ toast, onDone, onClose }) {
  const sites = useLoad(() => api("/api/sites"), []);
  const [form, setForm] = useState({ siteId: "", title: "", instructions: "", priority: "high", assignedRole: "supervisor", dueMinutes: 60 });
  return (
    <form className="card grid" onSubmit={(event) => {
      event.preventDefault();
      run(() => api("/api/actions", { method: "POST", body: { ...form, dueMinutes: Number(form.dueMinutes) } }), () => { toast("Action assigned."); onDone(); }, toast);
    }}>
      <h2>Assign an action</h2>
      <label className="field">Site
        <select value={form.siteId} onChange={(event) => setForm({ ...form, siteId: event.target.value })} required>
          <option value="">Choose a site</option>
          {sites.data?.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
      </label>
      <label className="field">Title<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required /></label>
      <label className="field">Instructions<textarea rows={3} value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} required /></label>
      <div className="row">
        <Select label="Priority" value={form.priority} options={[["routine", "Routine"], ["high", "High"], ["urgent", "Urgent"]]} onChange={(priority) => setForm({ ...form, priority })} />
        <Select label="Assign to" value={form.assignedRole} options={[["supervisor", "Site supervisor"], ["safety_lead", "Safety lead"]]} onChange={(assignedRole) => setForm({ ...form, assignedRole })} />
        <label className="field">Due in minutes<input type="number" min="5" max="1440" value={form.dueMinutes} onChange={(event) => setForm({ ...form, dueMinutes: event.target.value })} /></label>
      </div>
      <div className="row"><button className="btn">Create</button><button className="btn-secondary" type="button" onClick={onClose}>Cancel</button></div>
    </form>
  );
}

export function ActionPage({ id, me, toast }) {
  const { data, error, loading, reload } = useLoad(() => api(`/api/actions/${id}`), [id]);
  const [note, setNote] = useState("");
  const [barrier, setBarrier] = useState("other");
  const [reason, setReason] = useState("");
  if (loading) return <p>Loading action…</p>;
  if (error) return <div className="banner danger">{error}</div>;
  const { action, siteName, crew, events, canRespond, canCancel } = data;
  return (
    <Page title={action.title} lede={`${siteName}${crew ? ` · ${crew.name}` : ""} · ${action.assignedRole.replace("_", " ")}`}>
      <div className="row"><span className="badge">{action.priority}</span><span className="badge">{action.status}</span>{action.escalationLevel > 0 && <span className="badge">Escalation {action.escalationLevel}</span>}{action.overdue && <span className="badge risk-extreme">Overdue</span>}</div>
      <article className="card"><p style={{ whiteSpace: "pre-wrap" }}>{action.instructions}</p><p className="muted">Acknowledge by {when(action.ackDueAt)} · complete by {when(action.dueAt)}</p></article>
      {canRespond && ["open", "acknowledged", "blocked"].includes(action.status) && (
        <div className="card grid">
          <div className="row">
            {action.status === "open" && <button className="btn" onClick={() => run(() => api(`/api/actions/${id}/acknowledge`, { method: "POST" }), () => { toast("Acknowledged."); reload(); }, toast)}>Acknowledge</button>}
            {action.status !== "blocked" || me.role === "safety_lead" ? <button className="btn" onClick={() => run(() => api(`/api/actions/${id}/complete`, { method: "POST", body: { note } }), () => { toast("Completed."); reload(); }, toast)}>Complete</button> : null}
          </div>
          {action.status !== "blocked" && (
            <div className="grid">
              <Select label="Barrier" value={barrier} options={BARRIERS} onChange={setBarrier} />
              <label className="field">What is stopping this?<textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></label>
              <button className="btn-danger" onClick={() => run(() => api(`/api/actions/${id}/block`, { method: "POST", body: { barrier, note } }), () => { toast("Marked blocked and escalated."); reload(); }, toast)}>Mark blocked</button>
            </div>
          )}
        </div>
      )}
      {canCancel && ["open", "acknowledged", "blocked"].includes(action.status) && (
        <form className="card row" onSubmit={(event) => { event.preventDefault(); run(() => api(`/api/actions/${id}/cancel`, { method: "POST", body: { reason } }), () => { toast("Cancelled."); reload(); }, toast); }}>
          <label className="field" style={{ flex: 1 }}>Cancel reason<input value={reason} onChange={(event) => setReason(event.target.value)} required /></label>
          <button className="btn-secondary">Cancel action</button>
        </form>
      )}
      <article className="card">
        <h2>Record</h2>
        {events.map((event) => <p key={event.id}><strong>{event.type}</strong> · {event.actorLabel} · {when(event.at)}{event.detail?.note ? ` — ${event.detail.note}` : ""}{event.detail?.reason ? ` — ${event.detail.reason}` : ""}</p>)}
        <form className="row" onSubmit={(event) => { event.preventDefault(); run(() => api(`/api/actions/${id}/notes`, { method: "POST", body: { note } }), () => { setNote(""); toast("Note added."); reload(); }, toast); }}>
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a note" style={{ flex: 1 }} />
          <button className="btn-secondary">Add note</button>
        </form>
      </article>
    </Page>
  );
}

export function ProtocolsPage({ go, me, toast }) {
  const { data, error, loading, reload } = useLoad(() => api("/api/protocols"), []);
  return (
    <Page title="Heat-safety protocol" lede="Drafts are edited by one Safety Lead and approved by a different Safety Lead." actions={me.permissions.includes("protocols.edit") && <button className="btn" onClick={() => run(() => api("/api/protocols", { method: "POST", body: {} }), (created) => go(`/protocols/${created.id}`), toast)}>New draft</button>}>
      {loading && <p>Loading protocols…</p>}
      {error && <div className="banner danger">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Version</th><th>Name</th><th>Status</th><th>Approved</th><th></th></tr></thead>
          <tbody>
            {data?.map((protocol) => (
              <tr key={protocol.id}>
                <td>v{protocol.version}</td><td>{protocol.name}</td><td>{protocol.status.replaceAll("_", " ")}</td><td>{protocol.approvedByLabel ?? "—"}</td>
                <td><button className="btn-secondary" onClick={() => go(`/protocols/${protocol.id}`)}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

export function ProtocolPage({ id, me, toast, go }) {
  const { data, error, loading, reload } = useLoad(() => api(`/api/protocols/${id}`), [id]);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [configText, setConfigText] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (!data) return;
    setName(data.name);
    setNotes(data.notes ?? "");
    setConfigText(JSON.stringify(data.config, null, 2));
  }, [data]);
  if (loading) return <p>Loading protocol…</p>;
  if (error) return <div className="banner danger">{error}</div>;
  const editable = data.status === "draft" && me.permissions.includes("protocols.edit");
  return (
    <Page title={`${data.name} · v${data.version}`} lede={data.status.replaceAll("_", " ")} actions={<button className="btn-secondary" onClick={() => go("/protocols")}>All versions</button>}>
      {data.config.exampleOnly && <div className="banner">These thresholds are illustrative. Clear “example only” inside the configuration only after the organization has validated them.</div>}
      <article className="card">
        <h2>Thresholds in use</h2>
        <p className="muted">{data.config.source}</p>
        <p>On-site measurement from {data.config.requireOnsiteMeasurementAtOrAbove}. Human review from {data.config.humanReviewAtOrAbove}. Second escalation after {data.config.escalation.level2AfterMinutes} minutes.</p>
      </article>
      {editable ? (
        <form className="card grid" onSubmit={(event) => {
          event.preventDefault();
          let config;
          try { config = JSON.parse(configText); } catch { toast("The configuration is not valid JSON."); return; }
          run(() => api(`/api/protocols/${id}`, { method: "PATCH", body: { name, notes, config } }), () => { toast("Draft saved."); reload(); }, toast);
        }}>
          <label className="field">Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field">Notes<textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
          <label className="field">Configuration JSON<textarea rows={16} value={configText} onChange={(event) => setConfigText(event.target.value)} spellCheck={false} /></label>
          <div className="row">
            <button className="btn">Save draft</button>
            <button type="button" className="btn-secondary" onClick={() => run(() => api(`/api/protocols/${id}/submit`, { method: "POST" }), () => { toast("Submitted for a second approver."); reload(); }, toast)}>Submit for approval</button>
          </div>
        </form>
      ) : <article className="card"><h2>Controls</h2>{data.config.controls.map((control) => <p key={control.id}><strong>{control.title}</strong> · {control.assignedRole.replace("_", " ")} · {control.priority}</p>)}</article>}
      {data.status === "pending_approval" && me.permissions.includes("protocols.approve") && (
        <div className="card grid">
          {data.isMine ? <div className="banner">Two-person rule: someone other than the author or submitter must approve this version.</div> : (
            <button className="btn" onClick={() => run(() => api(`/api/protocols/${id}/approve`, { method: "POST" }), () => { toast("Protocol approved."); reload(); }, toast)}>Approve and make active</button>
          )}
          <form className="row" onSubmit={(event) => { event.preventDefault(); run(() => api(`/api/protocols/${id}/reject`, { method: "POST", body: { reason } }), () => { toast("Rejected."); go("/protocols"); }, toast); }}>
            <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for rejection" required style={{ flex: 1 }} />
            <button className="btn-secondary">Reject</button>
          </form>
        </div>
      )}
    </Page>
  );
}

export function InsightsPage() {
  const [days, setDays] = useState(28);
  const { data, error, loading } = useLoad(() => api(`/api/insights?days=${days}`), [days]);
  return (
    <Page title="Insights" lede="Site-level totals only. This view has no individual worker records." actions={
      <>
        <select value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="Period">
          <option value={7}>7 days</option><option value={28}>28 days</option><option value={90}>90 days</option>
        </select>
        <a className="btn-secondary" href={`/api/insights.csv?days=${days}`} style={{ textDecoration: "none" }}>Export CSV</a>
      </>
    }>
      {loading && <p>Building the summary…</p>}
      {error && <div className="banner danger">{error}</div>}
      {data?.overall && (
        <>
          <div className="grid stats">
            <article className="card stat"><span className="muted">Assessments</span><b>{data.overall.assessments}</b><Meter label="High or extreme share" value={data.overall.assessments ? Math.round((data.overall.highOrExtreme / data.overall.assessments) * 100) : 0} color="#c45c12" /></article>
            <article className="card stat"><span className="muted">High or extreme</span><b>{data.overall.highOrExtreme}</b><span className="muted">{data.overall.unknown} unknown</span></article>
            <article className="card stat"><span className="muted">On-time completion</span><b>{data.overall.completedOnTimePct ?? "—"}%</b><Meter label="Ack on time" value={data.overall.ackOnTimePct} color="#0f6e6b" /></article>
            <article className="card stat"><span className="muted">Measured data</span><b>{data.overall.measuredPct ?? "—"}%</b><Meter label="Valid data" value={data.overall.validDataPct} color="#176b45" /></article>
          </div>
          <div className="grid chart-grid">
            <article className="card">
              <DonutChart
                title="Outcome mix"
                items={[
                  { id: "high", label: "High / extreme", value: data.overall.highOrExtreme, color: "#c45c12" },
                  { id: "unknown", label: "Unknown", value: data.overall.unknown, color: "#5a6b7a" },
                  { id: "other", label: "Other", value: Math.max(0, data.overall.assessments - data.overall.highOrExtreme - data.overall.unknown), color: "#176b45" },
                ]}
                centerLabel="assessed"
                centerValue={data.overall.assessments}
              />
            </article>
            <article className="card">
              <DonutChart
                title="Action pressure"
                items={[
                  { id: "overdue", label: "Overdue", value: data.overall.overdue, color: "#9f2d2d" },
                  { id: "escalated", label: "Escalated", value: data.overall.escalated, color: "#c45c12" },
                  { id: "blocked", label: "Blocked", value: data.overall.blocked, color: "#8a5a10" },
                  { id: "rest", label: "Other actions", value: Math.max(0, data.overall.actions - data.overall.overdue - data.overall.escalated - data.overall.blocked), color: "#0f6e6b" },
                ]}
                centerLabel="actions"
                centerValue={data.overall.actions}
              />
            </article>
            <article className="card">
              <HorizontalBars
                title="Barriers reported"
                items={(data.barriers ?? []).map((barrier) => ({ id: barrier.id, label: barrier.label, value: barrier.count, color: "#9f2d2d" }))}
              />
            </article>
            <article className="card">
              <HorizontalBars
                title="Controls completed late"
                items={(data.lateControls ?? []).map((control) => ({
                  id: control.controlId,
                  label: control.title,
                  value: control.late,
                  meta: `${control.latePct ?? 0}% late`,
                  color: "#c45c12",
                }))}
              />
            </article>
          </div>
          <div className="split">
            <article className="card">
              <LineChart
                title="Daily trend"
                series={(data.trend ?? []).map((point) => ({
                  label: point.day.slice(5),
                  assessments: point.assessments,
                  highOrExtreme: point.highOrExtreme,
                }))}
                colors={["#0f6e6b", "#c45c12"]}
              />
            </article>
            <article className="card">
              <BarChart
                title="High or extreme by UTC hour"
                series={(data.hours ?? []).map((point) => ({ label: String(point.hourUtc).padStart(2, "0"), count: point.count }))}
                colors={["#9f2d2d"]}
              />
            </article>
          </div>
          <article className="card">
            <HorizontalBars
              title="Site comparison"
              valueLabel="assessments"
              items={(data.perSite ?? []).map((site) => ({
                id: site.siteId,
                label: site.siteName,
                value: site.assessments,
                meta: `${site.highOrExtreme} high/extreme · ${site.completedOnTimePct ?? "—"}% on time`,
                color: site.highOrExtreme > 0 ? "#c45c12" : "#0f6e6b",
              }))}
            />
          </article>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Site</th><th>Assessments</th><th>High/extreme</th><th>On-time</th><th>Escalated</th><th>Worker reports</th></tr></thead>
              <tbody>{data.perSite.map((site) => <tr key={site.siteId}><td>{site.siteName}</td><td>{site.assessments}</td><td>{site.highOrExtreme}</td><td>{site.completedOnTimePct ?? "—"}%</td><td>{site.escalated}</td><td>{site.workerReports}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
      {data && !data.overall && <article className="card">No site-level data in this period yet.</article>}
    </Page>
  );
}

export function AuditPage() {
  const [entityType, setEntityType] = useState("");
  const { data, error, loading } = useLoad(() => api(`/api/audit${entityType ? `?entityType=${entityType}` : ""}`), [entityType]);
  return (
    <Page title="Audit log" lede="Append-only. Entries cannot be edited." actions={
      <select value={entityType} onChange={(event) => setEntityType(event.target.value)} aria-label="Record type">
        <option value="">All record types</option>
        {["action", "assessment", "protocol", "reading", "site", "crew", "user", "worker_report", "organization"].map((type) => <option key={type} value={type}>{type.replace("_", " ")}</option>)}
      </select>
    }>
      {loading && <p>Loading the log…</p>}
      {error && <div className="banner danger">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
          <tbody>{data?.map((entry) => <tr key={entry.id}><td>{when(entry.at)}</td><td>{entry.actorLabel}</td><td>{entry.summary}<div className="muted">{entry.action}</div></td></tr>)}</tbody>
        </table>
      </div>
    </Page>
  );
}

export function UsersPage({ toast }) {
  const users = useLoad(() => api("/api/users"), []);
  const sites = useLoad(() => api("/api/sites"), []);
  const [form, setForm] = useState({ loginId: "", role: "supervisor", roleLabel: "", language: "en", siteIds: [] });
  const [secret, setSecret] = useState("");
  return (
    <Page title="People" lede="A new account receives a temporary password once. It must be changed at first sign-in.">
      {secret && <div className="banner ok">Temporary password: <strong>{secret}</strong>. Copy it now. It will not be shown again.</div>}
      <form className="card grid" onSubmit={(event) => {
        event.preventDefault();
        run(() => api("/api/users", { method: "POST", body: form }), (created) => { setSecret(created.temporaryPassword); setForm({ ...form, loginId: "", roleLabel: "" }); users.reload(); }, toast);
      }}>
        <div className="grid" style={{ gridTemplateColumns: "1.2fr .8fr .8fr" }}>
          <label className="field">Login ID<input value={form.loginId} onChange={(event) => setForm({ ...form, loginId: event.target.value })} required /></label>
          <label className="field">Display label<input value={form.roleLabel} onChange={(event) => setForm({ ...form, roleLabel: event.target.value })} required /></label>
          <Select label="Role" value={form.role} options={[["org_admin", "Organization admin"], ["safety_lead", "Safety lead"], ["supervisor", "Supervisor"], ["worker", "Worker"], ["analyst", "Analyst"]]} onChange={(role) => setForm({ ...form, role })} />
        </div>
        <label className="field">Sites
          <select multiple value={form.siteIds} onChange={(event) => setForm({ ...form, siteIds: [...event.target.selectedOptions].map((option) => option.value) })}>
            {sites.data?.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
        </label>
        <button className="btn">Create account</button>
      </form>
      {users.error && <div className="banner danger">{users.error}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Login</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {users.data?.map((user) => (
              <tr key={user.id}>
                <td>{user.loginId}<div className="muted">{user.roleLabel}</div></td>
                <td>{user.role.replaceAll("_", " ")}</td>
                <td>{user.active ? "Active" : "Inactive"}{user.mustChangePassword ? " · password change required" : ""}</td>
                <td className="row">
                  <button className="btn-secondary" onClick={() => run(() => api(`/api/users/${user.id}/reset-password`, { method: "POST" }), (result) => setSecret(result.temporaryPassword), toast)}>Reset password</button>
                  <button className="btn-secondary" onClick={() => run(() => api(`/api/users/${user.id}`, { method: "PATCH", body: { active: !user.active } }), () => users.reload(), toast)}>{user.active ? "Deactivate" : "Reactivate"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

export function SettingsPage({ toast }) {
  const { data, error, loading, reload } = useLoad(() => api("/api/settings"), []);
  const [form, setForm] = useState(null);
  if (loading) return <p>Loading settings…</p>;
  if (error) return <div className="banner danger">{error}</div>;
  const value = form ?? data;
  return (
    <Page title="Organization" lede="Retention keeps closed actions, readings, sessions and alerts for the stated number of days.">
      <form className="card grid" onSubmit={(event) => {
        event.preventDefault();
        run(() => api("/api/settings", { method: "PATCH", body: value }), () => { toast("Settings saved."); setForm(null); reload(); }, toast);
      }}>
        <label className="field">Name<input value={value.name} onChange={(event) => setForm({ ...value, name: event.target.value })} /></label>
        <label className="field">Time zone<input value={value.timezone} onChange={(event) => setForm({ ...value, timezone: event.target.value })} /></label>
        <div className="grid stats">
          {["actions", "readings", "sessions", "notifications"].map((key) => (
            <label key={key} className="field">{key}<input type="number" value={value.retentionDays[key]} onChange={(event) => setForm({ ...value, retentionDays: { ...value.retentionDays, [key]: Number(event.target.value) } })} /></label>
          ))}
        </div>
        <button className="btn">Save settings</button>
      </form>
    </Page>
  );
}

export function WorkerPage({ me, toast }) {
  const [language, setLanguage] = useState(me.language);
  const { data, error, loading, reload } = useLoad(() => api(`/api/worker/status?language=${language}`), [language]);
  const [report, setReport] = useState({ siteId: "", crewId: "", type: "no_water", location: "", note: "" });
  const [guidance, setGuidance] = useState("");
  return (
    <Page title="Your instructions" lede="These are the current protective instructions for your site. Reports are stored without your name." actions={
      <select value={language} aria-label="Language" onChange={async (event) => {
        const next = event.target.value;
        setLanguage(next);
        await api("/api/me", { method: "PATCH", body: { language: next } }).catch((err) => toast(err.message));
      }}>
        <option value="en">English</option><option value="hi">हिन्दी</option><option value="ar">العربية</option>
      </select>
    }>
      {data?.translationNote && <div className="banner">{data.translationNote}</div>}
      {guidance && <div className="banner danger">{guidance}</div>}
      {loading && <p>Loading instructions…</p>}
      {error && <div className="banner danger">{error}</div>}
      {data?.sites?.map((site) => (
        <article key={site.id} className="card">
          <h2>{site.name}</h2>
          {site.crews.map((crew) => (
            <div key={crew.id} className="crew">
              <div className="row"><RiskBadge level={crew.riskLevel} /><strong>{crew.name}</strong><span className="muted">{crew.workArea}</span></div>
              <p>{crew.message}</p>
              <ul>{crew.instructions.map((line) => <li key={line}>{line}</li>)}</ul>
              {crew.assessmentId && !crew.acknowledged && <button className="btn" onClick={() => run(() => api("/api/worker/ack", { method: "POST", body: { assessmentId: crew.assessmentId } }), () => reload(), toast)}>I have read this</button>}
              {crew.acknowledged && <p className="muted">You have read the current instructions.</p>}
            </div>
          ))}
        </article>
      ))}
      {data?.sites?.length > 0 && (
        <form className="card grid" onSubmit={(event) => {
          event.preventDefault();
          run(() => api("/api/worker/reports", { method: "POST", body: report }), (result) => { setGuidance(result.guidance); setReport({ ...report, location: "", note: "" }); }, toast);
        }}>
          <h2>Report a problem</h2>
          <label className="field">Site
            <select value={report.siteId} required onChange={(event) => setReport({ ...report, siteId: event.target.value, crewId: "" })}>
              <option value="">Choose</option>
              {data.sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
            </select>
          </label>
          <Select label="What is wrong?" value={report.type} options={REPORTS} onChange={(type) => setReport({ ...report, type })} />
          <label className="field">Where?<input value={report.location} onChange={(event) => setReport({ ...report, location: event.target.value })} /></label>
          <label className="field">Note<input value={report.note} onChange={(event) => setReport({ ...report, note: event.target.value })} /></label>
          <button className="btn">Send report</button>
        </form>
      )}
    </Page>
  );
}

export function AccountPage({ me, toast, onChanged }) {
  return (
    <Page title="Account" lede={`${me.loginId} · ${me.roleLabel}`}>
      <article className="card"><PasswordForm onChanged={async () => { toast("Password updated."); await onChanged(); }} /></article>
    </Page>
  );
}

export function PasswordForm({ onChanged }) {
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNext] = useState("");
  const [error, setError] = useState("");
  return (
    <form className="grid" onSubmit={async (event) => {
      event.preventDefault();
      setError("");
      try {
        await api("/api/auth/password", { method: "POST", body: { currentPassword, newPassword } });
        await onChanged();
      } catch (err) { setError(err.message); }
    }}>
      <label className="field">Current password<input type="password" value={currentPassword} onChange={(event) => setCurrent(event.target.value)} required /></label>
      <label className="field">New password<input type="password" value={newPassword} onChange={(event) => setNext(event.target.value)} required /></label>
      <p className="muted">At least 12 characters, using three of lower-case, upper-case, numbers and symbols.</p>
      {error && <div className="banner danger">{error}</div>}
      <button className="btn">Update password</button>
    </form>
  );
}
