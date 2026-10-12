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
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "158145639528-h5o0qd8v12ddlkht2t325ijdvv2v5sir.apps.googleusercontent.com";
const GOOGLE_REDIRECT = "com.googleusercontent.apps.158145639528-h5o0qd8v12ddlkht2t325ijdvv2v5sir:/oauth2redirect";
const CONTENT_DIR = process.env.CONTENT_DIR || "/home/deploy/rokugard/content";
let contentCache = null;

function loadContent() {
  const pack = path.join(CONTENT_DIR, "pack.bin");
  const metaPath = path.join(CONTENT_DIR, "meta.json");
  if (!fs.existsSync(pack) || !fs.existsSync(metaPath)) return null;
  const stat = fs.statSync(pack);
  if (contentCache && contentCache.mtime === stat.mtimeMs && contentCache.size === stat.size) return contentCache;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  if (!meta.key || !meta.sha256 || meta.bytes !== stat.size) return null;
  contentCache = { pack, key: meta.key, sha256: meta.sha256, bytes: stat.size, mtime: stat.mtimeMs, size: stat.size };
  return contentCache;
}

function servePack(req, res, file, size) {
  const headers = {
    "content-type": "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "access-control-expose-headers": "content-length, content-range, accept-ranges",
    ...corsHeaders(req),
  };
  const range = String(req.headers.range || "");
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (match) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : size - 1;
    if (start >= size || end < start) {
      res.writeHead(416, { "content-range": `bytes */${size}`, ...headers });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "content-length": size });
  fs.createReadStream(file).pipe(res);
}

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
CREATE TABLE IF NOT EXISTS mail (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  day DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_daily_once ON mail (user_id, day) WHERE kind = 'daily' AND day IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mail_welcome_once ON mail (user_id) WHERE kind = 'welcome';
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;
CREATE TABLE IF NOT EXISTS oauth_pending (
  id TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS tag TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_tag ON users (tag) WHERE tag IS NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS queue_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS friends (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, other_id)
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  a_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'found',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS seed INT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS first_seat TEXT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS a_deck JSONB;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS b_deck JSONB;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS a_name TEXT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS b_name TEXT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS seq INT NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS a_loaded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS b_loaded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS tossed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
CREATE TABLE IF NOT EXISTS match_acts (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  seat TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (match_id, seq)
);
`;

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders(res.req || {}),
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

function limaDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

const DAILY_DAYS = 30;
function dailyPayload(index) {
  const day = index + 1;
  if (day === 30) return { gems: 40, packs: 1 };
  if (day % 7 === 0) return { packs: 1 };
  if (day === 1) return { gems: 20 };
  return { gems: 15 };
}

function cleanGrant(body) {
  const gems = Math.max(0, Math.min(5000, Math.floor(Number(body.gems) || 0)));
  const packs = Math.max(0, Math.min(20, Math.floor(Number(body.packs) || 0)));
  const card = String(body.cardId || body.card || "").trim();
  const gold = Math.max(0, Math.min(5000, Math.floor(Number(body.gold) || 0)));
  const out = {};
  if (gems) out.gems = gems;
  if (packs) out.packs = packs;
  if (gold) out.gold = gold;
  if (card) out.card = card;
  return out;
}

function publicMail(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    payload: row.payload,
    day: row.day,
    createdAt: row.created_at,
  };
}

async function grantWelcome(userId) {
  await pool.query(
    `INSERT INTO mail (id, user_id, kind, title, payload)
     VALUES ($1,$2,'welcome','Bienvenida',$3)
     ON CONFLICT DO NOTHING`,
    [newId("mail"), userId, JSON.stringify({ gems: 200, packs: 5 })],
  );
}

async function ensureDaily(userId) {
  const day = limaDay();
  const have = await pool.query("SELECT count(*)::int AS n FROM mail WHERE user_id = $1 AND kind = 'daily'", [userId]);
  const n = have.rows[0].n;
  if (n >= DAILY_DAYS) return;
  const today = await pool.query("SELECT id FROM mail WHERE user_id = $1 AND kind = 'daily' AND day = $2", [userId, day]);
  if (today.rows.length) return;
  const payload = dailyPayload(n);
  await pool.query(
    `INSERT INTO mail (id, user_id, kind, title, payload, day)
     VALUES ($1,$2,'daily',$3,$4,$5)
     ON CONFLICT DO NOTHING`,
    [newId("mail"), userId, `Día ${n + 1}`, JSON.stringify(payload), day],
  );
}

function corsHeaders(req) {
  const origin = String(req.headers.origin || "");
  const ok = origin.startsWith("capacitor://") || origin.startsWith("http://localhost") || origin.startsWith("https://localhost") || origin.startsWith("http://127.0.0.1");
  if (!ok) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-headers": "content-type, authorization, x-rokugard-version",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

function clientVersion(req) {
  return req.headers["x-rokugard-version"] || req.headers["x-client-version"] || null;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id, email: row.email, name: row.name, tag: row.tag || "", role: row.role, banned: row.banned,
    banReason: row.ban_reason, clientVersion: row.client_version, lastSeenAt: row.last_seen_at, createdAt: row.created_at,
  };
}

async function getSessionUser(req) {
  const header = String(req.headers.authorization || "");
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1] || "";
  const sid = bearer || parseCookies(req).rk_session;
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

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function googleStart() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = newId("gst");
  await pool.query("DELETE FROM oauth_pending WHERE created_at < now() - interval '15 minutes'");
  await pool.query("INSERT INTO oauth_pending (id, code_verifier) VALUES ($1,$2)", [state, verifier]);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", GOOGLE_REDIRECT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return { url: url.toString(), state };
}

async function googleIdentity(code, state) {
  const found = await pool.query("SELECT code_verifier, created_at FROM oauth_pending WHERE id = $1", [state]);
  const row = found.rows[0];
  if (!row) return { error: "El ingreso con Google venció. Inténtalo otra vez.", status: 410 };
  await pool.query("DELETE FROM oauth_pending WHERE id = $1", [state]);
  const body = new URLSearchParams({
    code: String(code || ""),
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT,
    grant_type: "authorization_code",
    code_verifier: row.code_verifier,
  });
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !token.id_token) return { error: "Google no confirmó la cuenta.", status: 401 };
  const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token.id_token)}`);
  const info = await infoRes.json().catch(() => ({}));
  if (!infoRes.ok || info.aud !== GOOGLE_CLIENT_ID) return { error: "Google no confirmó la cuenta.", status: 401 };
  if (String(info.email_verified) !== "true") return { error: "Ese correo de Google no está verificado.", status: 403 };
  const email = String(info.email || "").trim().toLowerCase();
  const sub = String(info.sub || "");
  if (!email.includes("@") || !sub) return { error: "Google no entregó el correo.", status: 401 };
  return { email, sub, name: String(info.name || email.split("@")[0]).slice(0, 80) };
}

async function loginGoogleIdentity(identity, version) {
  let user = (await pool.query("SELECT * FROM users WHERE google_sub = $1", [identity.sub])).rows[0];
  if (!user) user = (await pool.query("SELECT * FROM users WHERE email = $1", [identity.email])).rows[0];
  let created = false;
  if (!user) {
    const cfg = (await pool.query("SELECT registration_open, beta_open FROM game_config WHERE id = 1")).rows[0];
    if (!cfg.registration_open && !cfg.beta_open) return { error: "El registro está cerrado.", status: 403 };
    const inserted = await pool.query(
      `INSERT INTO users (id, email, name, password_hash, google_sub, client_version) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [newId("usr"), identity.email, identity.name, "google:no-password", identity.sub, version],
    );
    user = inserted.rows[0];
    created = true;
    await grantWelcome(user.id);
  } else if (!user.google_sub) {
    await pool.query("UPDATE users SET google_sub = $2 WHERE id = $1 AND google_sub IS NULL", [user.id, identity.sub]);
  } else if (user.google_sub !== identity.sub) {
    return { error: "Ese correo ya está ligado a otra cuenta de Google.", status: 409 };
  }
  if (user.banned) return { error: "Cuenta suspendida.", status: 403, reason: user.ban_reason };
  const sid = await createSession(user.id);
  await pool.query("UPDATE users SET last_seen_at = now(), client_version = COALESCE($2, client_version) WHERE id = $1", [user.id, version]);
  return { user: publicUser(user), token: sid, created };
}

const TAG_ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeTag() {
  let s = "RG-";
  for (let i = 0; i < 4; i += 1) s += TAG_ALPH[crypto.randomInt(TAG_ALPH.length)];
  return s;
}

async function ensureTag(user) {
  if (user.tag) return user.tag;
  for (let i = 0; i < 8; i += 1) {
    const tag = makeTag();
    await pool.query("UPDATE users SET tag = $2 WHERE id = $1 AND tag IS NULL", [user.id, tag]).catch(() => {});
    const { rows } = await pool.query("SELECT tag FROM users WHERE id = $1", [user.id]);
    if (rows[0]?.tag) {
      user.tag = rows[0].tag;
      return rows[0].tag;
    }
  }
  return "";
}

function onlineOf(row) {
  const seen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
  return Date.now() - seen < 45000;
}

async function socialState(user) {
  await ensureTag(user);
  await pool.query("UPDATE users SET last_seen_at = now() WHERE id = $1", [user.id]);
  const friends = await pool.query(
    `SELECT u.id, u.name, u.tag, u.last_seen_at FROM friends f JOIN users u ON u.id = f.other_id WHERE f.user_id = $1 ORDER BY u.name`,
    [user.id],
  );
  const invites = await pool.query(
    `SELECT i.id, i.kind, u.name, u.tag, u.last_seen_at FROM invites i JOIN users u ON u.id = i.from_id
     WHERE i.to_id = $1 AND i.status = 'pending' AND i.created_at > now() - interval '10 minutes' ORDER BY i.created_at DESC`,
    [user.id],
  );
  const outgoing = await pool.query(
    `SELECT i.id, i.kind, u.name, u.tag FROM invites i JOIN users u ON u.id = i.to_id
     WHERE i.from_id = $1 AND i.status = 'pending' AND i.created_at > now() - interval '10 minutes' ORDER BY i.created_at DESC`,
    [user.id],
  );
  const match = await pool.query(
    `SELECT m.id, m.status, m.a_id, m.b_id, m.seed, m.first_seat, m.seq,
            m.a_deck IS NOT NULL AS a_ready, m.b_deck IS NOT NULL AS b_ready,
            u.name, u.tag
     FROM matches m
     JOIN users u ON u.id = CASE WHEN m.a_id = $1 THEN m.b_id ELSE m.a_id END
     WHERE (m.a_id = $1 OR m.b_id = $1) AND m.status IN ('found', 'live') AND m.created_at > now() - interval '30 minutes'
     ORDER BY m.created_at DESC LIMIT 1`,
    [user.id],
  );
  const me = (await pool.query("SELECT tag, name, queue_at FROM users WHERE id = $1", [user.id])).rows[0] || {};
  const searching = await pool.query(
    `SELECT count(*)::int AS n FROM users WHERE queue_at IS NOT NULL AND last_seen_at > now() - interval '45 seconds'`,
  );
  const row = match.rows[0];
  const youA = row ? row.a_id === user.id : false;
  return {
    me: { tag: me.tag || "", name: me.name || "" },
    queued: Boolean(me.queue_at),
    searching: searching.rows[0]?.n || 0,
    friends: friends.rows.map((r) => ({ tag: r.tag, name: r.name, online: onlineOf(r) })),
    invites: invites.rows.map((r) => ({ id: r.id, kind: r.kind, fromTag: r.tag, fromName: r.name, online: onlineOf(r) })),
    outgoing: outgoing.rows.map((r) => ({ id: r.id, kind: r.kind, toTag: r.tag, toName: r.name })),
    match: row ? {
      id: row.id,
      foeName: row.name,
      foeTag: row.tag,
      status: row.status,
      youReady: Boolean(youA ? row.a_ready : row.b_ready),
      foeReady: Boolean(youA ? row.b_ready : row.a_ready),
    } : null,
  };
}

async function findByTag(tag) {
  const { rows } = await pool.query("SELECT id, name, tag, last_seen_at FROM users WHERE tag = $1", [String(tag || "").toUpperCase()]);
  return rows[0] || null;
}

async function currentMatch(user) {
  const { rows } = await pool.query(
    `SELECT m.*, ua.name AS name_a, ub.name AS name_b, ua.avatar AS avatar_a, ub.avatar AS avatar_b
     FROM matches m
     JOIN users ua ON ua.id = m.a_id
     JOIN users ub ON ub.id = m.b_id
     WHERE (m.a_id = $1 OR m.b_id = $1) AND m.status IN ('found', 'live', 'done')
       AND m.created_at > now() - interval '30 minutes'
     ORDER BY m.created_at DESC LIMIT 1`,
    [user.id],
  );
  return rows[0] || null;
}

function safeAvatar(value) {
  const src = String(value || "");
  if (src.includes("..")) return "";
  if (src.startsWith("/avatars/") || src.startsWith("/story/portraits/")) return src;
  return "";
}

function tableView(user, row, actions = []) {
  if (!row) return { match: null };
  const youA = row.a_id === user.id;
  const deck = (value) => Array.isArray(value) ? value : [];
  return {
    match: {
      id: row.id,
      status: row.status,
      you: youA ? "a" : "b",
      foeName: youA ? row.name_b : row.name_a,
      foeTag: "",
      aName: row.name_a,
      bName: row.name_b,
      seed: row.seed || 0,
      first: row.first_seat || "a",
      yourDeck: deck(youA ? row.a_deck : row.b_deck),
      foeDeck: deck(youA ? row.b_deck : row.a_deck),
      youReady: Boolean(youA ? row.a_deck : row.b_deck),
      foeReady: Boolean(youA ? row.b_deck : row.a_deck),
      youLoaded: Boolean(youA ? row.a_loaded : row.b_loaded),
      foeLoaded: Boolean(youA ? row.b_loaded : row.a_loaded),
      youToss: ((Number(row.seed) || 0) % 2 === 0) === youA,
      tossed: Boolean(row.tossed),
      foeAvatar: safeAvatar(youA ? row.avatar_b : row.avatar_a),
      seq: row.seq || 0,
      actions,
    },
  };
}

async function handleSocial(req, res, p) {
  const { user } = await getSessionUser(req);
  if (!user) return json(res, 401, { error: "No hay sesión." });
  if (user.banned) return json(res, 403, { error: "Cuenta suspendida." });
  const body = req.method === "POST" ? await readBody(req) : {};
  if (p === "/v1/social/sync") return json(res, 200, await socialState(user));
  if (p === "/v1/social/name") {
    const name = String(body.name || "").trim().slice(0, 24);
    if (name.length < 2) return json(res, 400, { error: "El nombre necesita al menos 2 letras." });
    await pool.query("UPDATE users SET name = $2 WHERE id = $1", [user.id, name]);
    return json(res, 200, await socialState(user));
  }
  if (p === "/v1/social/search") {
    const q = String(body.q || "").trim();
    if (q.length < 2) return json(res, 200, { hits: [] });
    const { rows } = await pool.query(
      `SELECT name, tag, last_seen_at FROM users WHERE id <> $1 AND (tag = $2 OR name ILIKE $3) ORDER BY name LIMIT 8`,
      [user.id, q.toUpperCase(), `%${q.replace(/[%_]/g, "")}%`],
    );
    return json(res, 200, { hits: rows.map((r) => ({ name: r.name, tag: r.tag, online: onlineOf(r) })) });
  }
  if (p === "/v1/social/friend" || p === "/v1/social/duel") {
    const other = await findByTag(body.tag);
    if (!other || other.id === user.id) return json(res, 404, { error: "No hay un jugador con ese ID." });
    const kind = p.endsWith("duel") ? "duel" : "friend";
    if (kind === "duel" && !onlineOf(other)) return json(res, 409, { error: "Ese jugador no está en línea." });
    if (kind === "friend") {
      const already = await pool.query("SELECT 1 FROM friends WHERE user_id = $1 AND other_id = $2", [user.id, other.id]);
      if (already.rows.length) return json(res, 409, { error: "Ya está en tu lista." });
    }
    const pending = await pool.query(
      `SELECT id FROM invites WHERE from_id = $1 AND to_id = $2 AND kind = $3 AND status = 'pending' AND created_at > now() - interval '10 minutes'`,
      [user.id, other.id, kind],
    );
    if (!pending.rows.length) {
      await pool.query("INSERT INTO invites (id, from_id, to_id, kind) VALUES ($1,$2,$3,$4)", [newId("inv"), user.id, other.id, kind]);
    }
    return json(res, 200, { ok: true, sent: true, ...(await socialState(user)) });
  }
  if (p === "/v1/social/remove") {
    const other = await findByTag(body.tag);
    if (!other) return json(res, 404, { error: "No hay un jugador con ese ID." });
    await pool.query(
      "DELETE FROM friends WHERE (user_id = $1 AND other_id = $2) OR (user_id = $2 AND other_id = $1)",
      [user.id, other.id],
    );
    await pool.query(
      `UPDATE invites SET status = 'cancelled' WHERE status = 'pending' AND ((from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1))`,
      [user.id, other.id],
    );
    return json(res, 200, await socialState(user));
  }
  if (p === "/v1/social/cancel") {
    await pool.query(
      "UPDATE invites SET status = 'cancelled' WHERE id = $1 AND from_id = $2 AND status = 'pending'",
      [String(body.id || ""), user.id],
    );
    return json(res, 200, await socialState(user));
  }
  if (p === "/v1/social/answer") {
    const { rows } = await pool.query(
      `UPDATE invites SET status = $3 WHERE id = $1 AND to_id = $2 AND status = 'pending' RETURNING id, from_id, kind`,
      [String(body.id || ""), user.id, body.accept ? "accepted" : "declined"],
    );
    const inv = rows[0];
    if (!inv) return json(res, 409, { error: "Esa invitación ya no está." });
    if (body.accept && inv.kind === "friend") {
      await pool.query(
        `INSERT INTO friends (user_id, other_id) VALUES ($1,$2), ($2,$1) ON CONFLICT DO NOTHING`,
        [user.id, inv.from_id],
      );
    }
    if (body.accept && inv.kind === "duel") {
      await pool.query("INSERT INTO matches (id, a_id, b_id) VALUES ($1,$2,$3)", [newId("match"), inv.from_id, user.id]);
    }
    return json(res, 200, await socialState(user));
  }
  if (p === "/v1/social/ready") {
    const row = await currentMatch(user);
    if (!row) return json(res, 404, { error: "No hay una sala abierta." });
    const deck = Array.isArray(body.deck) ? body.deck.map((id) => String(id)).slice(0, 60) : [];
    if (deck.length !== 60) return json(res, 400, { error: "La baraja tiene que tener 60 cartas." });
    const youA = row.a_id === user.id;
    await pool.query(
      `UPDATE matches SET ${youA ? "a_deck" : "b_deck"} = $2::jsonb WHERE id = $1`,
      [row.id, JSON.stringify(deck)],
    );
    const fresh = await currentMatch(user);
    if (fresh && fresh.a_deck && fresh.b_deck && fresh.status === "found") {
      const seed = crypto.randomInt(1, 2147483646);
      const first = crypto.randomInt(2) === 0 ? "a" : "b";
      await pool.query(
        `UPDATE matches SET status = 'live', seed = $2, first_seat = $3, a_loaded = false, b_loaded = false, tossed = false WHERE id = $1 AND status = 'found'`,
        [fresh.id, seed, first],
      );
    }
    return json(res, 200, tableView(user, await currentMatch(user)));
  }
  if (p === "/v1/social/loaded") {
    const row = await currentMatch(user);
    if (!row || row.status !== "live") return json(res, 409, { error: "La mesa todavía no está." });
    const youA = row.a_id === user.id;
    await pool.query(
      `UPDATE matches SET ${youA ? "a_loaded" : "b_loaded"} = true WHERE id = $1`,
      [row.id],
    );
    return json(res, 200, tableView(user, await currentMatch(user)));
  }
  if (p === "/v1/social/toss") {
    const row = await currentMatch(user);
    if (!row || row.status !== "live") return json(res, 409, { error: "La mesa todavía no está." });
    const youA = row.a_id === user.id;
    const youToss = ((Number(row.seed) || 0) % 2 === 0) === youA;
    if (!youToss) return json(res, 403, { error: "La moneda la lanza el rival." });
    await pool.query("UPDATE matches SET tossed = true WHERE id = $1", [row.id]);
    return json(res, 200, tableView(user, await currentMatch(user)));
  }
  if (p === "/v1/social/avatar") {
    const avatar = safeAvatar(body.avatar);
    if (!avatar) return json(res, 400, { error: "Ese retrato no está disponible." });
    await pool.query("UPDATE users SET avatar = $2 WHERE id = $1", [user.id, avatar]);
    return json(res, 200, { ok: true, avatar });
  }
  if (p === "/v1/social/close") {
    await pool.query(
      `UPDATE matches SET status = 'done' WHERE status IN ('found', 'live') AND (a_id = $1 OR b_id = $1)`,
      [user.id],
    );
    return json(res, 200, { ok: true });
  }
  if (p === "/v1/social/act") {
    const row = await currentMatch(user);
    if (!row || row.status !== "live") return json(res, 409, { error: "La mesa todavía no está." });
    if (!body.action || typeof body.action !== "object") return json(res, 400, { error: "Falta la jugada." });
    const seat = row.a_id === user.id ? "a" : "b";
    const updated = await pool.query(
      `UPDATE matches SET seq = seq + 1 WHERE id = $1 AND status = 'live' RETURNING seq`,
      [row.id],
    );
    const seq = updated.rows[0]?.seq;
    if (!seq) return json(res, 409, { error: "La mesa ya se cerró." });
    await pool.query(
      "INSERT INTO match_acts (match_id, seq, seat, payload) VALUES ($1,$2,$3,$4)",
      [row.id, seq, seat, JSON.stringify(body.action)],
    );
    return json(res, 200, { ok: true, seq });
  }
  if (p === "/v1/social/table") {
    const row = await currentMatch(user);
    if (!row) return json(res, 200, { match: null });
    const since = Math.max(0, Math.floor(Number(body.since) || 0));
    const acts = await pool.query(
      `SELECT seq, payload FROM match_acts WHERE match_id = $1 AND seq > $2 ORDER BY seq ASC`,
      [row.id, since],
    );
    const actions = acts.rows.map((act) => ({ seq: act.seq, action: act.payload }));
    return json(res, 200, tableView(user, row, actions));
  }
  if (p === "/v1/social/queue") {
    if (!body.join) {
      await pool.query("UPDATE users SET queue_at = NULL WHERE id = $1", [user.id]);
      if (body.close) {
        await pool.query(
          `UPDATE matches SET status = 'done' WHERE status IN ('found', 'live') AND (a_id = $1 OR b_id = $1)`,
          [user.id],
        );
      }
      return json(res, 200, await socialState(user));
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE users SET queue_at = now(), last_seen_at = now() WHERE id = $1", [user.id]);
      const other = await client.query(
        `SELECT id FROM users
         WHERE queue_at IS NOT NULL AND id <> $1 AND last_seen_at > now() - interval '45 seconds'
           AND NOT EXISTS (
             SELECT 1 FROM matches m WHERE m.status = 'found' AND m.created_at > now() - interval '10 minutes'
               AND (m.a_id = users.id OR m.b_id = users.id)
           )
         ORDER BY queue_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [user.id],
      );
      if (other.rows[0]) {
        await client.query("UPDATE users SET queue_at = NULL WHERE id = $1 OR id = $2", [user.id, other.rows[0].id]);
        await client.query("INSERT INTO matches (id, a_id, b_id) VALUES ($1,$2,$3)", [newId("match"), user.id, other.rows[0].id]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return json(res, 200, await socialState(user));
  }
  return json(res, 404, { error: "No existe." });
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
      await grantWelcome(rows[0].id);
      const sid = await createSession(rows[0].id);
      return json(res, 201, { user: publicUser(rows[0]), token: sid }, { "set-cookie": cookieHeader("rk_session", sid, { maxAge: 14 * 86400 }) });
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
    return json(res, 200, { user: publicUser(user), token: sid }, { "set-cookie": cookieHeader("rk_session", sid, { maxAge: 14 * 86400 }) });
  }
  if (method === "POST" && p === "/v1/auth/logout") {
    const sid = parseCookies(req).rk_session;
    if (sid) await pool.query("DELETE FROM sessions WHERE id = $1", [sid]);
    return json(res, 200, { ok: true }, { "set-cookie": cookieHeader("rk_session", "", { maxAge: 0 }) });
  }
  if (method === "POST" && p === "/v1/auth/google/start") {
    return json(res, 200, await googleStart());
  }
  if (method === "POST" && p === "/v1/auth/google") {
    const body = await readBody(req);
    const identity = await googleIdentity(body.code, String(body.state || ""));
    if (identity.error) return json(res, identity.status || 401, { error: identity.error });
    try {
      const session = await loginGoogleIdentity(identity, clientVersion(req));
      if (session.error) return json(res, session.status || 403, { error: session.error, reason: session.reason });
      return json(res, 200, { user: session.user, token: session.token, created: session.created }, { "set-cookie": cookieHeader("rk_session", session.token, { maxAge: 14 * 86400 }) });
    } catch (err) {
      if (String(err.message).includes("users_email_key") || String(err.message).includes("users_google_sub")) {
        return json(res, 409, { error: "Ese correo ya está registrado." });
      }
      throw err;
    }
  }
  if ((method === "GET") && (p === "/v1/content/manifest" || p === "/v1/content/pack")) {
    const { user } = await getSessionUser(req);
    if (!user) return json(res, 401, { error: "No hay sesión." });
    if (user.banned) return json(res, 403, { error: "Cuenta suspendida." });
    const content = loadContent();
    if (!content) return json(res, 503, { error: "El paquete no está en el servidor." });
    if (p === "/v1/content/manifest") return json(res, 200, { v: 1, bytes: content.bytes, sha256: content.sha256, key: content.key });
    return servePack(req, res, content.pack, content.bytes);
  }
  if (p.startsWith("/v1/social/")) return handleSocial(req, res, p);
  if (method === "GET" && p === "/v1/me") {
    const { user } = await getSessionUser(req);
    if (!user) return json(res, 401, { error: "No hay sesión." });
    if (user.banned) return json(res, 403, { error: "Cuenta suspendida.", reason: user.ban_reason });
    return json(res, 200, { user: publicUser(user) });
  }
  if (method === "POST" && p === "/v1/mailbox/sync") {
    const { user } = await getSessionUser(req);
    if (!user) return json(res, 401, { error: "No hay sesión." });
    if (user.banned) return json(res, 403, { error: "Cuenta suspendida.", reason: user.ban_reason });
    await ensureDaily(user.id);
    const { rows } = await pool.query(
      `SELECT id, kind, title, payload, day, created_at FROM mail WHERE user_id = $1 AND claimed_at IS NULL ORDER BY created_at ASC`,
      [user.id],
    );
    const count = await pool.query("SELECT count(*)::int AS n FROM mail WHERE user_id = $1 AND kind = 'daily'", [user.id]);
    return json(res, 200, { mail: rows.map(publicMail), dailyDone: count.rows[0].n, dailyMax: DAILY_DAYS });
  }
  if (method === "POST" && p === "/v1/mailbox/claim") {
    const { user } = await getSessionUser(req);
    if (!user) return json(res, 401, { error: "No hay sesión." });
    if (user.banned) return json(res, 403, { error: "Cuenta suspendida." });
    const body = await readBody(req);
    const id = String(body.id || "");
    const { rows } = await pool.query(
      `UPDATE mail SET claimed_at = now() WHERE id = $1 AND user_id = $2 AND claimed_at IS NULL RETURNING id, kind, title, payload`,
      [id, user.id],
    );
    if (!rows.length) return json(res, 409, { error: "Ese regalo ya se cobró." });
    return json(res, 200, { ok: true, mail: publicMail(rows[0]) });
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
      await client.query(
        `INSERT INTO mail (id, user_id, kind, title, payload) VALUES ($1,$2,'code',$3,$4)`,
        [newId("mail"), user.id, row.bundle_name, JSON.stringify(row.grants)],
      );
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
    if (method === "POST" && p.startsWith("/v1/admin/users/") && p.endsWith("/delete")) {
      const id = p.split("/")[4];
      if (id === user.id) return json(res, 400, { error: "No puedes borrar tu propia cuenta." });
      const found = await pool.query("SELECT id, role, email FROM users WHERE id = $1", [id]);
      if (!found.rows.length) return json(res, 404, { error: "No está." });
      if (found.rows[0].role === "admin") return json(res, 400, { error: "No se borra un admin." });
      await pool.query("DELETE FROM users WHERE id = $1", [id]);
      await audit(user.id, "user.delete", id, { email: found.rows[0].email });
      return json(res, 200, { ok: true });
    }
    if (method === "POST" && p === "/v1/admin/mail") {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const found = await pool.query("SELECT id, email FROM users WHERE email = $1", [email]);
      if (!found.rows.length) return json(res, 404, { error: "Ese email no está registrado." });
      const payload = cleanGrant(body);
      if (!Object.keys(payload).length) return json(res, 400, { error: "El regalo está vacío." });
      const title = String(body.title || "Regalo").trim().slice(0, 80) || "Regalo";
      const id = newId("mail");
      await pool.query(
        `INSERT INTO mail (id, user_id, kind, title, payload) VALUES ($1,$2,'gift',$3,$4)`,
        [id, found.rows[0].id, title, JSON.stringify(payload)],
      );
      await audit(user.id, "mail.grant", found.rows[0].id, { title, payload });
      return json(res, 201, { ok: true, id });
    }
    if (method === "GET" && p === "/v1/admin/mail") {
      const { rows } = await pool.query(
        `SELECT m.id, m.kind, m.title, m.payload, m.day, m.created_at, m.claimed_at, u.email
         FROM mail m JOIN users u ON u.id = m.user_id
         ORDER BY m.created_at DESC LIMIT 80`,
      );
      return json(res, 200, { mail: rows });
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
    res.req = req;
    if (req.method === "OPTIONS") {
      const headers = corsHeaders(req);
      res.writeHead(204, headers);
      res.end();
      return;
    }
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
