import { createApp } from "./app.js";
import { config } from "./config.js";
import { pool, query } from "./db.js";
import { runEscalations, sweepRetention } from "./domain.js";
import { migrate } from "./migrate.js";
import { seedIfEmpty } from "./seed.js";
import { createWeather } from "./weather.js";

const weather = createWeather(config.weatherProvider);
let stopping = false;
let lastRetention = 0;

async function maintenance() {
  if (stopping) return;
  const now = () => new Date();
  try {
    await runEscalations({ query, actor: null, now, weather });
  } catch (error) {
    console.error("escalation sweep failed", error.message);
  }
  if (Date.now() - lastRetention < 60 * 60 * 1000) return;
  lastRetention = Date.now();
  try {
    await sweepRetention(query, new Date());
  } catch (error) {
    console.error("retention sweep failed", error.message);
  }
}

async function main() {
  await migrate();
  await seedIfEmpty();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`HeatShield API listening on :${config.port} (${config.nodeEnv}, weather: ${weather.label})`);
  });
  const timer = setInterval(maintenance, 60_000);
  timer.unref();
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
