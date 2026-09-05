import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 3010);
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "roku@waruchan.com").toLowerCase();
const ADMIN_BOOTSTRAP_PASSWORD = process.env.ADMIN_BOOTSTRAP_PASSWORD || "";
const ADMIN_NAME = process.env.ADMIN_NAME || "Roku";

if (!DATABASE_URL) {
  console.error("Falta DATABASE_URL");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player',
  banned BOOLEAN NOT NULL DEFAULT FALSE,
  ban_reason TEXT,
  banned_until TIMESTAMPTZ,
  client_version TEXT,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS game_config (
  id INT PRIMARY KEY DEFAULT 1,
  beta_open BOOLEAN NOT NULL DEFAULT FALSE,
  registration_open BOOLEAN NOT NULL DEFAULT FALSE,
  maintenance BOOLEAN NOT NULL DEFAULT FALSE,
  maintenance_msg TEXT,
  min_version TEXT NOT NULL DEFAULT '0.34.12',
  latest_version TEXT NOT NULL DEFAULT '0.34.12',
  apk_url TEXT
);
INSERT INTO game_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS bundles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  grants JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS redeem_codes (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  bundle_id TEXT NOT NULL REFERENCES bundles(id),
  max_uses INT NOT NULL DEFAULT 1,
  uses INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  redeemed_by TEXT REFERENCES users(id),
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id BIGSERIAL PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("JSON inválido")); }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(name, value, { maxAge } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax"];
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(password, salt, 32).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [algo, salt, derived] = String(stored || "").split(":");
  if (algo !== "scrypt" || !salt || !derived) return false;
  const check = crypto.scryptSync(password, salt, 32).toString("hex");
  try { return crypto.timingSafeEqual(Buffer.from(derived, "hex"), Buffer.from(check, "hex")); }
  catch { return false; }
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
}

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chunk = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  return `RK-${chunk()}-${chunk()}`;
}

function clientVersion(req) {
  return req.headers["x-rokugard-version"] || req.headers["x-client-version"] || null;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id, email: row.email, name: row.name, role: row.role, banned: row.banned,
    banReason: row.ban_reason, clientVersion: row.client_version, lastSeenAt: row.last_seen_at, createdAt: row.created_at,
  };
}

async function getSessionUser(req) {
  const sid = parseCookies(req).rk_session;
  if (!sid) return { session: null, user: null };
  const { rows } = await pool.query(
    `SELECT s.id AS session_id, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [sid],
  );
  const row = rows[0];
  if (!row || new Date(row.expires_at) < new Date()) {
    if (sid) await pool.query("DELETE FROM sessions WHERE id = $1", [sid]).catch(() => {});
    return { session: null, user: null };
  }
  return { session: { id: row.session_id }, user: row };
}

async function createSession(userId) {
  const id = newId("ses");
  const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000);
  await pool.query("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1,$2,$3)", [id, userId, expires]);
  return id;
}

async function audit(actorId, action, targetId, payload) {
  await pool.query(
    "INSERT INTO admin_audit (actor_id, action, target_id, payload) VALUES ($1,$2,$3,$4)",
    [actorId, action, targetId || null, payload ? JSON.stringify(payload) : null],
  );
}

async function bootstrapAdmin() {
  const { rows } = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (rows.length) return;
  if (!ADMIN_BOOTSTRAP_PASSWORD) {
    console.warn("No hay admin y falta ADMIN_BOOTSTRAP_PASSWORD");
    return;
  }
  await pool.query(
    `INSERT INTO users (id, email, name, password_hash, role)
     VALUES ($1,$2,$3,$4,'admin')
     ON CONFLICT (email) DO UPDATE SET role = 'admin', password_hash = EXCLUDED.password_hash`,
    [newId("usr"), ADMIN_EMAIL, ADMIN_NAME, hashPassword(ADMIN_BOOTSTRAP_PASSWORD)],
  );
  console.log(`Admin listo: ${ADMIN_EMAIL}`);
}

async function ensureBetaBundle() {
  await pool.query(
    `INSERT INTO bundles (id, name, grants)
     VALUES ('beta-tester-t1', 'Regalo beta T1', '{"gold":500,"marks":1,"note":"Bundle fundador de tester"}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
}

function isAdminHost(req) {
  return String(req.headers.host || "").split(":")[0].startsWith("admin-rkg");
}

async function handleApi(req, res, url) {
  const method = req.method || "GET";
  const p = url.pathname;
  if (method === "GET" && (p === "/v1/health" || p === "/health")) {
    return json(res, 200, { ok: true, service: "rokugard-ops" });
  }
  if (method === "GET" && p === "/v1/bootstrap") {
    const { user } = await getSessionUser(req);
    const cfg = (await pool.query("SELECT * FROM game_config WHERE id = 1")).rows[0];
    if (user) {
      await pool.query("UPDATE users SET last_seen_at = now(), client_version = COALESCE($2, client_version) WHERE id = $1", [user.id, clientVersion(req)]);
    }
    return json(res, 200, {
      betaOpen: cfg.beta_open, registrationOpen: cfg.registration_open, maintenance: cfg.maintenance,
      maintenanceMsg: cfg.maintenance_msg, minVersion: cfg.min_version, latestVersion: cfg.latest_version,
      apkUrl: cfg.apk_url, user: user ? publicUser(user) : null,
    });
  }
  if (method === "POST" && p === "/v1/auth/register") {
    const body = await readBody(req);
    const cfg = (await pool.query("SELECT registration_open, beta_open FROM game_config WHERE id = 1")).rows[0];
    if (!cfg.registration_open && !cfg.beta_open) return json(res, 403, { error: "El registro está cerrado." });
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const name = String(body.name || email.split("@")[0] || "Jugador").trim();
    if (!email.includes("@") || password.length < 8) return json(res, 400, { error: "Email válido y clave de 8+ caracteres." });
    try {
      const { rows } = await pool.query(
        `INSERT INTO users (id, email, name, password_hash, client_version) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [newId("usr"), email, name, hashPassword(password), clientVersion(req)],
      );
      const sid = await createSession(rows[0].id);
      return json(res, 201, { user: publicUser(rows[0]) }, { "set-cookie": cookieHeader("rk_session", sid, { maxAge: 14 * 86400 }) });
    } catch (err) {
      if (String(err.message).includes("users_email_key")) return json(res, 409, { error: "Ese email ya está registrado." });
      throw err;
    }
  }
  if (method === "POST" && p === "/v1/auth/login") {
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) return json(res, 401, { error: "Email o clave incorrectos." });
    if (user.banned) return json(res, 403, { error: "Cuenta suspendida.", reason: user.ban_reason });
    const sid = await createSession(user.id);
    await pool.query("UPDATE users SET last_seen_at = now() WHERE id = $1", [user.id]);
    return json(res, 200, { user: publicUser(user) }, { "set-cookie": cookieHeader("rk_session", sid, { maxAge: 14 * 86400 }) });
  }
  if (method === "POST" && p === "/v1/auth/logout") {
    const sid = parseCookies(req).rk_session;
    if (sid) await pool.query("DELETE FROM sessions WHERE id = $1", [sid]);
    return json(res, 200, { ok: true }, { "set-cookie": cookieHeader("rk_session", "", { maxAge: 0 }) });
  }
  if (method === "GET" && p === "/v1/me") {
    const { user } = await getSessionUser(req);
    if (!user) return json(res, 401, { error: "No hay sesión." });
    if (user.banned) return json(res, 403, { error: "Cuenta suspendida.", reason: user.ban_reason });
    return json(res, 200, { user: publicUser(user) });
  }
  if (method === "POST" && p === "/v1/redeem") {
    const { user } = await getSessionUser(req);
    if (!user) return json(res, 401, { error: "Inicia sesión para canjear." });
    if (user.banned) return json(res, 403, { error: "Cuenta suspendida." });
    const body = await readBody(req);
    const code = String(body.code || "").trim().toUpperCase();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(
        `SELECT c.*, b.grants, b.name AS bundle_name FROM redeem_codes c JOIN bundles b ON b.id = c.bundle_id WHERE c.code = $1 FOR UPDATE`,
        [code],
      );
      const row = found.rows[0];
      if (!row) { await client.query("ROLLBACK"); return json(res, 404, { error: "Código inválido." }); }
      if (row.revoked) { await client.query("ROLLBACK"); return json(res, 410, { error: "Código revocado." }); }
      if (row.expires_at && new Date(row.expires_at) < new Date()) { await client.query("ROLLBACK"); return json(res, 410, { error: "Código vencido." }); }
      if (row.uses >= row.max_uses) { await client.query("ROLLBACK"); return json(res, 409, { error: "Este código ya fue canjeado." }); }
      await client.query(`UPDATE redeem_codes SET uses = uses + 1, redeemed_by = $2, redeemed_at = now() WHERE id = $1`, [row.id, user.id]);
      await client.query(`INSERT INTO entitlements (id, user_id, kind, payload) VALUES ($1,$2,'bundle',$3)`, [newId("ent"), user.id, JSON.stringify({ bundleId: row.bundle_id, grants: row.grants, code })]);
      await client.query("COMMIT");
      return json(res, 200, { ok: true, bundle: row.bundle_name, grants: row.grants });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  if (p.startsWith("/v1/admin/") || p === "/v1/admin") {
    const { user } = await getSessionUser(req);
    if (!user || user.role !== "admin") return json(res, 403, { error: "Solo admin." });
    if (method === "GET" && p === "/v1/admin/overview") {
      const [cfg, users, codes, audits] = await Promise.all([
        pool.query("SELECT * FROM game_config WHERE id = 1"),
        pool.query("SELECT count(*)::int AS n FROM users"),
        pool.query("SELECT count(*) FILTER (WHERE uses = 0 AND NOT revoked)::int AS unused, count(*) FILTER (WHERE uses > 0)::int AS used FROM redeem_codes"),
        pool.query("SELECT * FROM admin_audit ORDER BY created_at DESC LIMIT 20"),
      ]);
      return json(res, 200, { config: cfg.rows[0], users: users.rows[0].n, codes: codes.rows[0], audit: audits.rows, me: publicUser(user) });
    }
    if (method === "POST" && p === "/v1/admin/config") {
      const body = await readBody(req);
      const { rows } = await pool.query(
        `UPDATE game_config SET
           beta_open = COALESCE($1, beta_open), registration_open = COALESCE($2, registration_open),
           maintenance = COALESCE($3, maintenance), maintenance_msg = COALESCE($4, maintenance_msg),
           min_version = COALESCE($5, min_version), latest_version = COALESCE($6, latest_version), apk_url = COALESCE($7, apk_url)
         WHERE id = 1 RETURNING *`,
        [body.betaOpen ?? null, body.registrationOpen ?? null, body.maintenance ?? null, body.maintenanceMsg ?? null, body.minVersion ?? null, body.latestVersion ?? null, body.apkUrl ?? null],
      );
      await audit(user.id, "config.update", null, body);
      return json(res, 200, { config: rows[0] });
    }
    if (method === "GET" && p === "/v1/admin/users") {
      const q = String(url.searchParams.get("q") || "").trim();
      const { rows } = await pool.query(
        `SELECT id, email, name, role, banned, ban_reason, client_version, last_seen_at, created_at FROM users
         WHERE ($1 = '' OR email ILIKE $2 OR name ILIKE $2) ORDER BY created_at DESC LIMIT 200`,
        [q, `%${q}%`],
      );
      return json(res, 200, { users: rows });
    }
    if (method === "POST" && p.startsWith("/v1/admin/users/") && p.endsWith("/ban")) {
      const id = p.split("/")[4];
      const body = await readBody(req);
      await pool.query("UPDATE users SET banned = TRUE, ban_reason = $2 WHERE id = $1", [id, body.reason || "ban"]);
      await pool.query("DELETE FROM sessions WHERE user_id = $1", [id]);
      await audit(user.id, "user.ban", id, body);
      return json(res, 200, { ok: true });
    }
    if (method === "POST" && p.startsWith("/v1/admin/users/") && p.endsWith("/unban")) {
      const id = p.split("/")[4];
      await pool.query("UPDATE users SET banned = FALSE, ban_reason = NULL WHERE id = $1", [id]);
      await audit(user.id, "user.unban", id, {});
      return json(res, 200, { ok: true });
    }
    if (method === "POST" && p === "/v1/admin/codes") {
      const body = await readBody(req);
      const bundleId = body.bundleId || "beta-tester-t1";
      const count = Math.min(Math.max(Number(body.count) || 1, 1), 100);
      const created = [];
      for (let i = 0; i < count; i++) {
        const id = newId("cd");
        const code = randomCode();
        await pool.query(`INSERT INTO redeem_codes (id, code, bundle_id, max_uses) VALUES ($1,$2,$3,1)`, [id, code, bundleId]);
        created.push(code);
      }
      await audit(user.id, "codes.create", bundleId, { count });
      return json(res, 201, { codes: created });
    }
    if (method === "GET" && p === "/v1/admin/codes") {
      const { rows } = await pool.query(
        `SELECT c.code, c.uses, c.max_uses, c.revoked, c.redeemed_at, c.created_at, b.name AS bundle_name, u.email AS redeemed_email
         FROM redeem_codes c JOIN bundles b ON b.id = c.bundle_id LEFT JOIN users u ON u.id = c.redeemed_by
         ORDER BY c.created_at DESC LIMIT 300`,
      );
      return json(res, 200, { codes: rows });
    }
    if (method === "POST" && p === "/v1/admin/codes/revoke") {
      const body = await readBody(req);
      await pool.query("UPDATE redeem_codes SET revoked = TRUE WHERE code = $1", [String(body.code || "").trim().toUpperCase()]);
      await audit(user.id, "codes.revoke", String(body.code || "").toUpperCase(), {});
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "Ruta admin no existe." });
  }
  return json(res, 404, { error: "No encontrado." });
}

function serveAdmin(req, res, url) {
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const file = path.join(PUBLIC_DIR, "admin.html");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `https://${host}`);
    if (url.pathname.startsWith("/v1/") || url.pathname === "/health") return await handleApi(req, res, url);
    if (isAdminHost(req)) return serveAdmin(req, res, url);
    if (url.pathname === "/") return json(res, 200, { service: "rokugard-api", hint: "/v1/bootstrap" });
    return json(res, 404, { error: "No encontrado." });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: "Error interno." });
  }
});

async function main() {
  await pool.query(SCHEMA);
  await bootstrapAdmin();
  await ensureBetaBundle();
  server.listen(PORT, "127.0.0.1", () => console.log(`rokugard-ops en 127.0.0.1:${PORT}`));
}

main().catch((err) => { console.error(err); process.exit(1); });
