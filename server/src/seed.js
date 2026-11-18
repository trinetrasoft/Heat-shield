import { passwordProblem, hashPassword } from "./crypto.js";
import { config } from "./config.js";
import { query } from "./db.js";
import { DEFAULT_PROTOCOL } from "./protocol.js";

export const DEMO_ACCOUNTS = [
  { loginId: "admin@heatshield.example", role: "org_admin", roleLabel: "Organization Admin", sites: [] },
  { loginId: "safety.lead@heatshield.example", role: "safety_lead", roleLabel: "Safety Lead · HQ", sites: [] },
  { loginId: "ohs.advisor@heatshield.example", role: "safety_lead", roleLabel: "Occupational Health Advisor", sites: [] },
  { loginId: "supervisor.north@heatshield.example", role: "supervisor", roleLabel: "Site Supervisor · North Yard", sites: ["NY"] },
  { loginId: "supervisor.harbour@heatshield.example", role: "supervisor", roleLabel: "Site Supervisor · Harbour Tower & Solar Farm", sites: ["HT", "SF"] },
  { loginId: "supervisor.depot@heatshield.example", role: "supervisor", roleLabel: "Site Supervisor · Metro Depot", sites: ["MD"] },
  { loginId: "worker.north@heatshield.example", role: "worker", roleLabel: "Worker · North Yard", sites: ["NY"] },
  { loginId: "worker.harbour@heatshield.example", role: "worker", roleLabel: "Worker · Harbour Tower", sites: ["HT"] },
  { loginId: "analyst@heatshield.example", role: "analyst", roleLabel: "Operations Analyst", sites: [] },
];

const SITES = [
  { code: "NY", name: "North Yard Logistics Hub", latitude: 24.52, longitude: 54.43, timezone: "Asia/Dubai", environment: "outdoor", facilities: { drinkingWater: true, shade: true, coolRestArea: false, notes: "Shade canopies at bays 2 and 5." }, hasWbgtInstrument: true },
  { code: "HT", name: "Harbour Tower Build", latitude: 24.49, longitude: 54.36, timezone: "Asia/Dubai", environment: "outdoor", facilities: { drinkingWater: true, shade: false, coolRestArea: true, notes: "Rest cabin on level 0." }, hasWbgtInstrument: false },
  { code: "SF", name: "Desert Solar Farm Maintenance", latitude: 24.08, longitude: 55.55, timezone: "Asia/Dubai", environment: "outdoor", facilities: { drinkingWater: false, shade: false, coolRestArea: false, notes: "Mobile crews; water carried in vehicles." }, hasWbgtInstrument: true },
  { code: "MD", name: "Metro Depot Workshop", latitude: 13.08, longitude: 80.27, timezone: "Asia/Kolkata", environment: "mixed", facilities: { drinkingWater: true, shade: true, coolRestArea: true, notes: "" }, hasWbgtInstrument: false },
];

const CREWS = {
  NY: [
    { name: "Crew A — Loading", workArea: "Bays 1–4", taskIntensity: "heavy", clothing: "standard", acclimatization: "acclimatized", shiftStart: "06:00", shiftEnd: "14:00" },
    { name: "Crew B — Yard marshals", workArea: "Gate and yard", taskIntensity: "moderate", clothing: "standard", acclimatization: "new_workers", shiftStart: "10:00", shiftEnd: "18:00" },
  ],
  HT: [
    { name: "Crew C — Roofing", workArea: "Roof deck, level 22", taskIntensity: "heavy", clothing: "coveralls", acclimatization: "mixed", shiftStart: "05:30", shiftEnd: "13:30" },
    { name: "Crew D — Façade", workArea: "East façade", taskIntensity: "moderate", clothing: "standard", acclimatization: "acclimatized", shiftStart: "07:00", shiftEnd: "15:00" },
  ],
  SF: [
    { name: "Crew E — Panel cleaning", workArea: "Rows 1–40", taskIntensity: "moderate", clothing: "double_layer", acclimatization: "acclimatized", shiftStart: "05:00", shiftEnd: "12:00" },
  ],
  MD: [
    { name: "Crew F — Track maintenance", workArea: "Stabling yard", taskIntensity: "heavy", clothing: "standard", acclimatization: "acclimatized", shiftStart: "08:00", shiftEnd: "16:00" },
  ],
};

export function getDemoCredentials() {
  if (!config.seedDemo || !config.demoPassword) {
    return { demo: false, password: null, accounts: [] };
  }
  return {
    demo: true,
    password: config.demoPassword,
    accounts: DEMO_ACCOUNTS.map((account) => ({
      loginId: account.loginId,
      role: account.role,
      roleLabel: account.roleLabel,
    })),
  };
}

export async function seedIfEmpty() {
  const [{ n }] = (await query("SELECT count(*)::int AS n FROM organizations"));
  if (n > 0) return;
  if (config.seedDemo) {
    const problem = passwordProblem(config.demoPassword);
    if (problem) throw new Error(`DEMO_PASSWORD is not usable: ${problem}`);
    await seedDemo(config.demoPassword);
    console.log("Seeded the demonstration organization. Change DEMO_PASSWORD accounts before any real use.");
    return;
  }
  const boot = config.bootstrap;
  if (!boot.orgName || !boot.adminLogin || !boot.adminPassword) {
    console.log("Database is empty. Set SEED_DEMO=true or BOOTSTRAP_ORG_NAME, BOOTSTRAP_ADMIN_LOGIN and BOOTSTRAP_ADMIN_PASSWORD.");
    return;
  }
  const problem = passwordProblem(boot.adminPassword);
  if (problem) throw new Error(`BOOTSTRAP_ADMIN_PASSWORD is not usable: ${problem}`);
  const passwordHash = await hashPassword(boot.adminPassword);
  const [org] = await query(
    `INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING id`,
    [boot.orgName, boot.timezone],
  );
  const [admin] = await query(
    `INSERT INTO users (org_id, login_id, role, role_label, password_hash, must_change_password)
     VALUES ($1, $2, 'org_admin', 'Organization Admin', $3, true) RETURNING id`,
    [org.id, boot.adminLogin, passwordHash],
  );
  await query(
    `INSERT INTO protocols (org_id, version, name, status, config, notes, created_by, approved_by, approved_at)
     VALUES ($1, 1, 'Heat-safety protocol', 'approved', $2::jsonb, $3, $4, $4, now())`,
    [org.id, JSON.stringify(DEFAULT_PROTOCOL), "Example thresholds. Replace them with the organization's validated protocol before relying on assessments.", admin.id],
  );
  console.log(`Bootstrapped organization for ${boot.adminLogin}. The admin must change the password on first sign-in.`);
}

async function seedDemo(password) {
  const passwordHash = await hashPassword(password);
  const [org] = await query(
    `INSERT INTO organizations (name, timezone) VALUES ('Fictional Construction & Logistics Co. (demo)', 'Asia/Dubai') RETURNING id`,
  );
  const siteIds = {};
  for (const site of SITES) {
    const [row] = await query(
      `INSERT INTO sites (org_id, name, code, latitude, longitude, timezone, environment, facilities, has_wbgt_instrument)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id`,
      [org.id, site.name, site.code, site.latitude, site.longitude, site.timezone, site.environment, JSON.stringify(site.facilities), site.hasWbgtInstrument],
    );
    siteIds[site.code] = row.id;
    for (const crew of CREWS[site.code]) {
      await query(
        `INSERT INTO crews (org_id, site_id, name, work_area, task_intensity, clothing, acclimatization, shift_start, shift_end)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [org.id, row.id, crew.name, crew.workArea, crew.taskIntensity, crew.clothing, crew.acclimatization, crew.shiftStart, crew.shiftEnd],
      );
    }
  }
  let approver = null;
  let author = null;
  for (const account of DEMO_ACCOUNTS) {
    const [user] = await query(
      `INSERT INTO users (org_id, login_id, role, role_label, password_hash, must_change_password, language)
       VALUES ($1,$2,$3,$4,$5,false,'en') RETURNING id`,
      [org.id, account.loginId, account.role, account.roleLabel, passwordHash],
    );
    if (account.loginId.startsWith("safety.lead")) author = user.id;
    if (account.loginId.startsWith("ohs.advisor")) approver = user.id;
    for (const code of account.sites) {
      await query(`INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2)`, [user.id, siteIds[code]]);
    }
  }
  await query(
    `INSERT INTO protocols (org_id, version, name, status, config, notes, created_by, submitted_by, submitted_at, approved_by, approved_at)
     VALUES ($1, 1, 'Example heat-safety protocol', 'approved', $2::jsonb, $3, $4, $4, now(), $5, now())`,
    [
      org.id,
      JSON.stringify(DEFAULT_PROTOCOL),
      "Demo only. Example thresholds — replace with your organization's validated protocol.",
      author,
      approver,
    ],
  );
}
