// api/orders-paid.js
import crypto from "crypto";

/** ================== Helpers base ================== **/
function env(name, required = true) {
  const v = process.env[name];
  if (required && (!v || String(v).trim() === "")) {
    throw new Error(`Falta variable de entorno: ${name}`);
  }
  return v;
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeJsonParse(buf) {
  try { return JSON.parse(buf.toString("utf8")); } catch { return null; }
}

function timingSafeEqual(a, b) {
  const A = Buffer.from(a || "", "utf8");
  const B = Buffer.from(b || "", "utf8");
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ================== Fetch Systeme robusto ================== **/
async function systemeFetch(path, opts = {}, { tolerate404 = false } = {}) {
  const base = "https://systeme.io";

  const withKey = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-API-Key": env("SYSTEME_API_KEY"),
    ...(opts.headers || {}),
  };
  const noKey = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };

  const urls = [path];
  if (path.startsWith("/api/public/")) {
    urls.push(path.replace(/^\/api\/public\//, "/api/"));
  } else if (path.startsWith("/api/")) {
    urls.push(path.replace(/^\/api\//, "/api/public/"));
  }

  const attempts = [];
  for (const u of urls) {
    attempts.push({ url: base + u, headers: withKey, label: `${u} [withKey]` });
    attempts.push({ url: base + u, headers: noKey,  label: `${u} [noKey]`  });
  }

  let last = null;
  let last404 = null;
  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, { ...opts, headers: attempt.headers });
      const text = await res.text();
      let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

      if (res.ok) {
        if (attempt.label.includes("[noKey]")) {
          console.log("Systeme OK", res.status, attempt.label);
        }
        return { ok: true, status: res.status, json };
      }

      console.warn("Systeme not OK", res.status, attempt.label);
      if (res.status === 404) {
        last404 = { ok: false, status: 404, json, attempt: attempt.label };
        continue; // probamos las demás variantes
      }
      last = { ok: false, status: res.status, json, attempt: attempt.label };
    } catch (e) {
      console.warn("Systeme fetch error for", attempt.label, String(e?.message || e));
      last = { ok: false, status: 0, json: { error: String(e?.message || e) }, attempt: attempt.label };
    }
  }

  if (tolerate404 && last404) {
    return { ok: false, status: 404, json: last404.json };
  }
  const fin = last || last404 || { status: "unknown", json: {} };
  console.error("Systeme error", fin.status, path, "lastAttempt:", fin.attempt);
  throw new Error(`Systeme ${path} error: ${fin.status}`);
}

/** ================== Tag ID desde el mapa (sin llamar a /api/tags) ================== **/
function getTagIdFromMap(sku) {
  let tagMap = {};
  try { tagMap = JSON.parse(process.env.COURSE_TAG_MAP_JSON || "{}"); } catch {}
  const raw = tagMap[sku];
  if (raw == null) throw new Error(`SKU "${sku}" no está mapeado en COURSE_TAG_MAP_JSON.`);
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`COURSE_TAG_MAP_JSON debe mapear a IDs NUMÉRICOS. Valor para SKU "${sku}": "${s}".`);
  }
  return Number(s);
}

/** ================== Contactos ================== **/
async function findContactIdByEmail(email) {
  const q = encodeURIComponent(email);
  const candidates = [
    `/api/contacts?email=${q}`,
    `/api/public/contacts?email=${q}`,
    `/api/contacts/search?email=${q}`,
    `/api/public/contacts/search?email=${q}`,
  ];

  for (const path of candidates) {
    try {
      const r = await systemeFetch(path, { method: "GET" }, { tolerate404: true });
      if (!r.ok) continue;
      const data = r.json;
      const list = Array.isArray(data?.items) ? data.items
                 : Array.isArray(data) ? data
                 : Array.isArray(data?.data) ? data.data
                 : [];
      const found = list.find(c => String(c?.email || "").toLowerCase() === email.toLowerCase());
      if (found?.id) return Number(found.id);
    } catch (e) {
      console.warn("Lookup fallback next for", path, String(e?.message || e));
    }
  }
  return null;
}

async function subscribeViaForm({ email, first_name = "", last_name = "" }) {
  const formId = process.env.SYSTEME_FALLBACK_FORM_ID;
  if (!formId) return null;

  const path = `/api/public/forms/${encodeURIComponent(formId)}/subscribe`;
  const body = JSON.stringify({ email, first_name, last_name });

  const r = await systemeFetch(path, { method: "POST", body }, { tolerate404: true });
  if (!r.ok) {
    console.warn("subscribeViaForm: endpoint público no disponible");
    return null;
  }

  for (let i = 0; i < 3; i++) {
    await sleep(600);
    const id = await findContactIdByEmail(email);
    if (id) return id;
  }
  return null;
}

async function createContact({ email, first_name = "", last_name = "" }) {
  const candidates = [
    { path: `/api/contacts`,        body: { email, first_name, last_name } },
    { path: `/api/public/contacts`, body: { email, first_name, last_name } },
  ];
  for (const c of candidates) {
    try {
      const r = await systemeFetch(c.path, { method: "POST", body: JSON.stringify(c.body) }, { tolerate404: true });
      if (r.ok) return Number(r.json?.id);
    } catch (e) {
      console.warn("Create contact intento fallido:", c.path, String(e?.message || e));
    }
  }

  const viaForm = await subscribeViaForm({ email, first_name, last_name });
  if (viaForm) return viaForm;

  throw new Error("No se pudo crear el contacto en Systeme (endpoints de contactos no disponibles).");
}

async function upsertSystemeContact({ email, first_name = "", last_name = "" }) {
  const existingId = await findContactIdByEmail(email);
  if (existingId) return existingId;

  const id = await createContact({ email, first_name, last_name });
  if (id) return id;

  const again = await findContactIdByEmail(email);
  if (again) return again;

  throw new Error("No se pudo upsert el contacto en Systeme.");
}

async function assignTagToContact(contactId, tagId) {
  try {
    await systemeFetch(`/api/contacts/${contactId}/tags`, {
      method: "POST",
      body: JSON.stringify({ tag_id: tagId })
    });
    return;
  } catch {
    await systemeFetch(`/api/public/contacts/${contactId}/tags`, {
      method: "POST",
      body: JSON.stringify({ tag_id: tagId })
    });
  }
}

/** ================== Handler ================== **/
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const raw = await readRawBody(req);

    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const topic = req.headers["x-shopify-topic"];
    const shop = req.headers["x-shopify-shop-domain"];
    if (!hmacHeader || !topic || !shop) return res.status(400).json({ error: "Bad Request" });

    if (shop !== env("SHOPIFY_SHOP_DOMAIN")) return res.status(401).json({ error: "Unauthorized" });
    const digest = crypto.createHmac("sha256", env("SHOPIFY_WEBHOOK_SECRET")).update(raw).digest("base64");
    if (!timingSafeEqual(digest, String(hmacHeader))) return res.status(401).json({ error: "Unauthorized" });

    if (topic !== "orders/paid") return res.status(200).json({ ok: true, ignored: true });

    const payload = safeJsonParse(raw);
    if (!payload) return res.status(400).json({ error: "Bad Request" });

    const email = String(payload?.email || payload?.customer?.email || "").trim();
    const firstName = payload?.customer?.first_name || payload?.billing_address?.first_name || "";
    const lastName  = payload?.customer?.last_name  || payload?.billing_address?.last_name  || "";
    if (!email) return res.status(200).json({ ok: true, reason: "order-without-email" });

    const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
    let matchedSku = null;
    for (const li of lineItems) {
      const sku = String(li?.sku || "").trim();
      if (sku) { matchedSku = sku; break; }
    }
    if (!matchedSku) return res.status(200).json({ ok: true, reason: "order-without-sku" });

    const tagId = getTagIdFromMap(matchedSku);
    console.log("SKU", matchedSku, "→ tagId:", tagId);

    const contactId = await upsertSystemeContact({ email, first_name: firstName, last_name: lastName });
    console.log("Contacto ID:", contactId);

    await assignTagToContact(contactId, tagId);
    console.log(`Tag ${tagId} asignado a ${contactId}`);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error", err);
    return res.status(200).json({ ok: true, error: String(err?.message || err) });
  }
}
