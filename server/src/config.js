function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value == null || value === "") {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function bool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const production = nodeEnv === "production";

export const config = {
  nodeEnv,
  production,
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required(
    "DATABASE_URL",
    production ? undefined : "postgres://heatshield:heatshield@localhost:5432/heatshield",
  ),
  sessionSecret: required(
    "SESSION_SECRET",
    production ? undefined : "dev-only-session-secret-change-me-please",
  ),
  cookieSecure: bool("COOKIE_SECURE", production),
  webOrigin: process.env.WEB_ORIGIN ?? "",
  trustProxy: bool("TRUST_PROXY", production),
  weatherProvider: process.env.WEATHER_PROVIDER ?? "open-meteo",
  seedDemo: bool("SEED_DEMO", !production),
  demoPassword: process.env.DEMO_PASSWORD ?? "",
  bootstrap: {
    orgName: process.env.BOOTSTRAP_ORG_NAME ?? "",
    adminLogin: (process.env.BOOTSTRAP_ADMIN_LOGIN ?? "").trim().toLowerCase(),
    adminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "",
    timezone: process.env.BOOTSTRAP_TIMEZONE ?? "UTC",
  },
};

if (config.sessionSecret.length < 24) {
  throw new Error("SESSION_SECRET must be at least 24 characters.");
}
