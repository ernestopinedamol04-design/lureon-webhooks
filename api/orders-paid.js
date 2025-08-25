// api/orders-paid.js
// Webhook de Shopify (orders/paid) -> Crear/actualizar contacto en Systeme y asignar tag por SKU
import crypto from "crypto";

// -------------------- Utilidades --------------------
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
  } catch (e) {
    console.error("JSON parse error", e);
    return null;
  }
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Llamada a Systeme con fallback /api -> /api/public si hay 404
async function systemeFetchWithFallback(path, opts = {}) {
  const base = "https://systeme.io";
  const headers = {
    "Content-Type": "application/json",
    "X-API-Key": env("SYSTEME_API_KEY"),
    ...(opts.headers || {}),
  };

  // 1er intento: /api/...
  const url1 = `${base}${path}`;
  let res = await fetch(url1, { ...opts, headers });
  let text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (res.status === 404 && path.startsWith("/api/") && !path.startsWith("/api/public/")) {
    // 2º intento: /api/public/...
    const pathPublic = path.replace(/^\/api\//, "/api/public/");
    const url2 = `${base}${pathPublic}`;
    res = await fetch(url2, { ...opts, headers });
    text = await res.text();
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  }

  if (!res.ok) {
    console.error("Systeme error", res.status, path, json);
    throw new Error(`Systeme ${path} error: ${res.status}`);
  }
  return json;
}

// -------------------- Tags --------------------
// Acepta valor como ID o nombre; si es nombre, busca y si no existe lo crea
async function resolveSystemeTagId(tagValue) {
  if (/^\d+$/.test(String(tagValue))) {
    return Number(tagValue); // ya es ID
  }
  const desiredName = String(tagValue).trim().toLowerCase();

  // listar tags (paginado simple)
  const list = await systemeFetchWithFallback(`/api/tags?perPage=100`, { method: "GET" });
  const items = Array.isArray(list?.items) ? list.items : Array.isArray(list) ? list : [];
  const found = items.find((t) => String(t?.name || "").toLowerCase() === desiredName);
  if (found?.id) return Number(found.id);

  // crear tag
  const created = await systemeFetchWithFallback(`/api/tags`, {
    method: "POST",
    body: JSON.stringify({ name: String(tagValue) }),
  });
  const tagId = Number(created?.id);
  if (!tagId) throw new Error("No se pudo crear el tag en Systeme.");
  console.log("Tag creado en Systeme:", tagId);
  return tagId;
}

// -------------------- Contactos --------------------
async function findContactIdByEmail(email) {
  const q = encodeURIComponent(email);
  const search = await systemeFetchWithFallback(`/api/contacts?email=${q}`, { method: "GET" });
  const items = Array.isArray(search?.items) ? search.items : Array.isArray(search) ? search : [];
  const found = items.find((c) => String(c?.email || "").toLowerCase() === email.toLowerCase());
  return found?.id ? Number(found.id) : null;
}

async function createContact({ email, first_name = "", last_name = "" }) {
  const created = await systemeFetchWithFallback(`/api/contacts`, {
    method: "POST",
    body: JSON.stringify({ email, first_name, last_name }),
  });
  return Number(created?.id);
}

async function upsertSystemeContact({ email, first_name = "", last_name = "" }) {
  // Busca primero por email para evitar duplicados y lidiar con cuentas que no “upsertean”
  const existingId = await findContactIdByEmail(email);
  if (existingId) return existingId;
  return await createContact({ email, first_name, last_name });
}

async function assignTagToContact(contactId, tagId) {
  await systemeFetchWithFallback(`/api/contacts/${contactId}/tags`, {
    method: "POST",
    body: JSON.stringify({ tag_id: tagId }),
  });
}

// -------------------- Handler --------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    // Raw body para HMAC
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

    // Determinar tag por SKU
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
    console.log("SKU", matchedSku, "→ tag configurado:", tagValue);

    // Resolver/crear tag e upsert contacto
    const tagId = await resolveSystemeTagId(tagValue);
    console.log("Tag ID a usar:", tagId);

    const contactId = await upsertSystemeContact({ email, first_name: firstName, last_name: lastName });
    console.log("Contacto Systeme id:", contactId);

    // Asignar tag (disparará tu automatización)
    await assignTagToContact(contactId, tagId);
    console.log(`Tag ${tagId} asignado a contacto ${contactId}`);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error", err);
    // Devolvemos 200 para que Shopify no reintente en bucle, pero registramos el error:
    return res.status(200).json({ ok: true, error: String(err?.message || err) });
  }
}
