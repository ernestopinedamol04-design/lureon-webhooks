// api/orders-paid.js
import crypto from "crypto";

// ================== Helpers base ==================
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
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

function timingSafeEqual(a, b) {
  const A = Buffer.from(a || "", "utf8");
  const B = Buffer.from(b || "", "utf8");
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

// ================== Fetch Systeme (con fallback /api <-> /api/public) ==================
async function systemeFetch(path, opts = {}, { tolerate404 = false } = {}) {
  const base = "https://systeme.io";
  const headers = {
    "Content-Type": "application/json",
    "X-API-Key": env("SYSTEME_API_KEY"),
    ...(opts.headers || {}),
  };

  // intento 1: tal cual
  let url = base + path;
  let res = await fetch(url, { ...opts, headers });

  // intento 2: alternar /api <-> /api/public si hay 404
  if (res.status === 404 && path.startsWith("/api/")) {
    const alt = path.startsWith("/api/public/")
      ? path.replace(/^\/api\/public\//, "/api/")
      : path.replace(/^\/api\//, "/api/public/");
    url = base + alt;
    res = await fetch(url, { ...opts, headers });
  }

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!res.ok) {
    if (tolerate404 && res.status === 404) {
      return { ok: false, status: 404, json };
    }
    console.error("Systeme error", res.status, path, json);
    throw new Error(`Systeme ${path} error: ${res.status}`);
  }
  return { ok: true, status: res.status, json };
}

// ================== Tags ==================
async function resolveSystemeTagId(tagValue) {
  if (/^\d+$/.test(String(tagValue))) return Number(tagValue);
  const desired = String(tagValue).trim().toLowerCase();

  const list = await systemeFetch(`/api/tags?perPage=100`, { method: "GET" });
  const items = Array.isArray(list.json?.items) ? list.json.items
              : Array.isArray(list.json) ? list.json
              : [];
  const hit = items.find(t => String(t?.name || "").toLowerCase() === desired);
  if (hit?.id) return Number(hit.id);

  const created = await systemeFetch(`/api/tags`, {
    method: "POST",
    body: JSON.stringify({ name: String(tagValue) })
  });
  const id = Number(created.json?.id);
  if (!id) throw new Error("No se pudo crear el tag en Systeme.");
  console.log("Tag creado:", id);
  return id;
}

// ================== Contactos ==================
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
      console.warn("Lookup email fallback next for", path, String(e?.message || e));
    }
  }
  return null;
}

// --- Fallback por formulario (Public API) ---
async function subscribeViaForm({ email, first_name = "", last_name = "" }) {
  const formId = process.env.SYSTEME_FALLBACK_FORM_ID;
  if (!formId) return null; // sin formulario, no podemos usar este plan B

  // Endpoint público típico de suscripción a formulario
  const path = `/api/public/forms/${encodeURIComponent(formId)}/subscribe`;
  const body = JSON.stringify({ email, first_name, last_name });

  try {
    const r = await systemeFetch(path, { method: "POST", body }, { tolerate404: true });
    if (!r.ok) return null;
    // Algunos devuelven {id} otros {contact:{id:...}} o nada; volvemos a buscar por email
    const after = await findContactIdByEmail(email);
    return after || null;
  } catch (e) {
    console.warn("subscribeViaForm fallo:", String(e?.message || e));
    return null;
  }
}

async function createContact({ email, first_name = "", last_name = "" }) {
  // 1) Intentar endpoints “contact”
  const candidates = [
    { path: `/api/contacts`, body: { email, first_name, last_name } },
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

  // 2) Plan B: suscribir al usuario a un formulario (si está configurado)
  const viaForm = await subscribeViaForm({ email, first_name, last_name });
  if (viaForm) return viaForm;

  // 3) Nada funcionó
  throw new Error("No se pudo crear el contacto en Systeme (endpoints de contactos no disponibles y sin FORM_ID).");
}

async function upsertSystemeContact({ email, first_name = "", last_name = "" }) {
  const existingId = await findContactIdByEmail(email);
  if (existingId) return existingId;

  try {
    const id = await createContact({ email, first_name, last_name });
    if (id) return id;
  } catch (e) {
    console.warn("Create contact falló, reintento búsqueda amplia:", String(e?.message || e));
    const again = await findContactIdByEmail(email);
    if (again) return again;
    throw e;
  }
}

async function assignTagToContact(contactId, tagId) {
  // Intento normal
  try {
    await systemeFetch(`/api/contacts/${contactId}/tags`, {
      method: "POST",
      body: JSON.stringify({ tag_id: tagId })
    });
    return;
  } catch (e) {
    // Intento alterno por public
    await systemeFetch(`/api/public/contacts/${contactId}/tags`, {
      method: "POST",
      body: JSON.stringify({ tag_id: tagId })
    });
  }
}

// ================== Handler ==================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const raw = await readRawBody(req);

    // Verificación Shopify
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

    // Map SKU -> tag (nombre o id)
    const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
    let tagMap = {};
    try { tagMap = JSON.parse(process.env.COURSE_TAG_MAP_JSON || "{}"); } catch { tagMap = {}; }

    let matchedSku = null;
    for (const li of lineItems) {
      const sku = String(li?.sku || "").trim();
      if (sku && tagMap[sku]) { matchedSku = sku; break; }
    }
    if (!matchedSku) return res.status(200).json({ ok: true, reason: "sku-not-mapped" });

    const tagValue = tagMap[matchedSku];
    console.log("SKU", matchedSku, "→ tag:", tagValue);

    const tagId = await resolveSystemeTagId(tagValue);
    console.log("Tag ID:", tagId);

    const contactId = await upsertSystemeContact({ email, first_name: firstName, last_name: lastName });
    console.log("Contacto ID:", contactId);

    await assignTagToContact(contactId, tagId);
    console.log(`Tag ${tagId} asignado a ${contactId}`);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error", err);
    // 200 para que Shopify no reintente en loop
    return res.status(200).json({ ok: true, error: String(err?.message || err) });
  }
}
