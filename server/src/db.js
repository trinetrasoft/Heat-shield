import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

function utf8Url(url) {
  if (url.includes("client_encoding")) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}options=-c%20client_encoding%3DUTF8`;
}

export const pool = new Pool({
  connectionString: utf8Url(config.databaseUrl),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export function mapRow(row) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
    out[camel] = value;
  }
  return out;
}

export function makeQuery(client) {
  return async (text, params = []) => {
    const result = await client.query(text, params);
    return result.rows.map(mapRow);
  };
}

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(makeQuery(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection already failed */
    }
    throw error;
  } finally {
    client.release();
  }
}

export const query = makeQuery(pool);
