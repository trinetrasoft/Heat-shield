import { useEffect, useState } from "react";
import { api } from "./api.js";
import { AccountPage, ActionPage, ActionsPage, AuditPage, Dashboard, InsightsPage, PasswordForm, ProtocolPage, ProtocolsPage, SettingsPage, SitePage, SitesPage, UsersPage, WorkerPage } from "./screens.jsx";

const NAV = [
  { href: "/", label: "Dashboard", permission: "dashboard.view" },
  { href: "/sites", label: "Sites", permission: "sites.view" },
  { href: "/actions", label: "Actions", permission: "actions.view" },
  { href: "/protocols", label: "Protocols", permission: "protocols.view" },
  { href: "/insights", label: "Insights", permission: "insights.view" },
  { href: "/audit", label: "Audit log", permission: "audit.view" },
  { href: "/users", label: "People", permission: "users.manage" },
  { href: "/settings", label: "Settings", permission: "settings.manage" },
  { href: "/work", label: "My instructions", permission: "worker.status" },
];

export function App() {
  const [me, setMe] = useState(undefined);
  const [path, setPath] = useState(window.location.pathname);
  const [notice, setNotice] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    api("/api/me").then(setMe).catch(() => setMe(null));
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!me || me.mustChangePassword || path !== "/") return;
    if (!me.permissions.includes("dashboard.view")) {
      go(me.permissions.includes("worker.status") ? "/work" : "/insights");
    }
  }, [me, path]);

  function go(href) {
    window.history.pushState({}, "", href);
    setPath(window.location.pathname);
    setNotesOpen(false);
  }
  function toast(message) {
    setNotice(message);
    setTimeout(() => setNotice(""), 5000);
  }

  if (me === undefined) return <main className="login"><p>Loading HeatShield Shift…</p></main>;
  if (!me) return <Login onSuccess={async () => setMe(await api("/api/me"))} />;
  if (me.mustChangePassword) {
    return <PasswordGate me={me} onChanged={async () => setMe(await api("/api/me"))} />;
  }

  const allowed = NAV.filter((item) => me.permissions.includes(item.permission));
  const screen = match(path);
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><div className="mark">HS</div><div><strong>HeatShield</strong><span>Shift</span></div></div>
        <nav className="nav">
          {allowed.map((item) => {
            const active = item.href === "/" ? path === "/" : path === item.href || path.startsWith(`${item.href}/`);
            return <button key={item.href} className={active ? "active" : ""} onClick={() => go(item.href)}>{item.label}</button>;
          })}
        </nav>
        <div className="spacer" />
        <button className="ghost" onClick={() => go("/account")}>{me.roleLabel}</button>
      </aside>
      <section className="main">
        <header className="top">
          <div><strong>{me.orgName}</strong><div className="muted">{me.timezone}</div></div>
          <div className="row">
            <button className="btn-secondary" onClick={() => setNotesOpen((open) => !open)}>Alerts</button>
            <button className="btn-secondary" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); setMe(null); }}>Sign out</button>
          </div>
          {notesOpen && <Notifications go={go} close={() => setNotesOpen(false)} />}
        </header>
        <div className="content">
          {screen.name === "dashboard" && <Dashboard go={go} />}
          {screen.name === "sites" && <SitesPage go={go} me={me} toast={toast} />}
          {screen.name === "site" && <SitePage id={screen.id} go={go} me={me} toast={toast} />}
          {screen.name === "actions" && <ActionsPage go={go} me={me} toast={toast} />}
          {screen.name === "action" && <ActionPage id={screen.id} me={me} toast={toast} />}
          {screen.name === "protocols" && <ProtocolsPage go={go} me={me} toast={toast} />}
          {screen.name === "protocol" && <ProtocolPage id={screen.id} me={me} toast={toast} go={go} />}
          {screen.name === "insights" && <InsightsPage />}
          {screen.name === "audit" && <AuditPage />}
          {screen.name === "users" && <UsersPage toast={toast} />}
          {screen.name === "settings" && <SettingsPage toast={toast} />}
          {screen.name === "work" && <WorkerPage me={me} toast={toast} />}
          {screen.name === "account" && <AccountPage me={me} toast={toast} onChanged={async () => setMe(await api("/api/me"))} />}
          {screen.name === "missing" && <p>That page is not available for your role.</p>}
        </div>
      </section>
      {notice && <div className="notice-pop" role="status">{notice}</div>}
    </div>
  );
}

function match(path) {
  const parts = path.split("/").filter(Boolean);
  const name = parts[0] ?? "dashboard";
  const routes = {
    "": "dashboard",
    sites: parts[1] ? "site" : "sites",
    actions: parts[1] ? "action" : "actions",
    protocols: parts[1] ? "protocol" : "protocols",
    insights: "insights",
    audit: "audit",
    users: "users",
    settings: "settings",
    work: "work",
    account: "account",
  };
  const resolved = routes[parts[0] ?? ""] ?? "missing";
  return { name: resolved, id: parts[1], key: `/${parts[0] ?? ""}` };
}

function Login({ onSuccess }) {
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(null);

  useEffect(() => {
    api("/api/auth/demo").then(setDemo).catch(() => setDemo({ demo: false }));
  }, []);

  function useAccount(account) {
    setLoginId(account.loginId);
    if (demo?.password) setPassword(demo.password);
  }

  return (
    <main className="login">
      <div className={`login-panel${demo?.demo ? " demo" : ""}`}>
        <form className="card" onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true); setError("");
          try {
            await api("/api/auth/login", { method: "POST", body: { loginId, password } });
            await onSuccess();
          } catch (err) { setError(err.message); } finally { setBusy(false); }
        }}>
          <div className="brand"><div className="mark">HS</div><div><strong>HeatShield Shift</strong><span>Heat-risk actions for outdoor crews</span></div></div>
          <h1>Sign in</h1>
          <p className="muted">Protective actions stay with a person. The system does not decide when work must stop.</p>
          <label className="field">Login ID<input value={loginId} onChange={(event) => setLoginId(event.target.value)} autoComplete="username" required /></label>
          <label className="field">Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
          {error && <div className="banner danger">{error}</div>}
          <button className="btn" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
        {demo?.demo && (
          <aside className="card demo-creds">
            <h2>Demo accounts</h2>
            <p className="muted">Shared password for every account:</p>
            <p className="demo-password"><code>{demo.password}</code></p>
            <p className="muted">Click an account to fill the form.</p>
            <div className="demo-list">
              {demo.accounts.map((account) => (
                <button key={account.loginId} type="button" className="demo-account" onClick={() => useAccount(account)}>
                  <strong>{account.roleLabel}</strong>
                  <span>{account.loginId}</span>
                </button>
              ))}
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}

function PasswordGate({ onChanged }) {
  return (
    <main className="login">
      <div className="card" style={{ width: "min(480px, 100%)" }}>
        <h1>Set a new password</h1>
        <p className="muted">This account must choose its own password before any heat-safety records can be opened.</p>
        <PasswordForm onChanged={onChanged} />
      </div>
    </main>
  );
}

function Notifications({ go, close }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    api("/api/notifications").then(async (payload) => {
      setData(payload);
      if (payload.unread) await api("/api/notifications/read", { method: "POST" });
    }).catch(() => setData({ items: [] }));
  }, []);
  return (
    <div className="menu" role="dialog" aria-label="Alerts">
      {!data && <p className="muted">Loading alerts…</p>}
      {data?.items?.length === 0 && <p className="muted">No alerts.</p>}
      {data?.items?.map((item) => (
        <button key={item.id} className="link" onClick={() => { close(); if (item.link) go(item.link); }}>
          <strong>{item.title}</strong>
          <div className="muted">{item.body}</div>
        </button>
      ))}
    </div>
  );
}
