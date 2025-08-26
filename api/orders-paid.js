// api/orders-paid.js
import crypto from "crypto";

/** ============== Utils básicos ============== */
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

/** ============== Fetch Systeme robusto ============== */
/**
 * Prueba combinaciones de:
 * - baseUrl: api.systeme.io (por defecto) y systeme.io (fallback)
 * - path: tal cual, y variantes /api <-> /api/public
 * - headers: con y sin X-API-Key
 */
async function systemeFetch(path, opts = {}, { tolerate404 = false } = {}) {
  const defaultBase = "https://api.systeme.io";
  const baseFromEnv = process.env.SYSTEME_API_BASE && process.env.SYSTEME_API_BASE.trim();
  const bases = [baseFromEnv || defaultBase, "https://systeme.io"];

  const withKey = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-API-Key": process.env.SYSTEME_API_KEY || "",
    ...(opts.headers || {}),
  };
  const noKey = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };

  // Generar variantes del path
  const pathVariants = new Set();
  pathVariants.add(path);

  // si empieza con /api/public -> añadir /api/ y sin /api
  if (path.startsWith("/api/public/")) {
    pathVariants.add(path.replace(/^\/api\/public\//, "/api/"));
    pathVariants.add(path.replace(/^\/api\/public\//, "/public/"));
  }
  // si empieza con /api/ -> añadir /api/public y sin /api
  if (path.startsWith("/api/")) {
    pathVariants.add(path.replace(/^\/api\//, "/api/public/"));
    pathVariants.add(path.replace(/^\/api\//, "/"));
  }
  // si empieza con /public/ -> añadir /api/public
  if (path.startsWith("/public/")) {
    pathVariants.add(path.replace(/^\/public\//, "/api/public/"));
  }
  // si no tiene /api ni /public, añadir ambas
  if (!/^\/(api|public)\//.test(path)) {
    pathVariants.add("/api" + (path.startsWith("/") ? "" : "/") + path);
    pathVariants.add("/api/public" + (path.startsWith("/") ? "" : "/") + path);
  }

  const attempts = [];
  for (const base of bases) {
    for (const p of pathVariants) {
      attempts.push({ url: base + p, headers: withKey, label: `${base}${p} [withKey]` });
      attempts.push({ url: base + p, headers: noKey,  label: `${base}${p} [noKey]`  });
    }
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
        continue;
      }
      last = { ok: false, status: res.status, json, attempt: attempt.label };
    } catch (e) {
      console.warn("Systeme fetch error for", attempt.label, String(e?.message || e));
      last = { ok: false, status: 0, json: { error: String(e?.message || e) }, attempt: attempt.label };
    }
  }

  if (tolerate404 && last404) return last404;
  const fin = last || last404 || { status: "unknown", json: {} };
  console.error("Systeme error", fin.status, path, "lastAttempt:", fin.attempt);
  throw new Error(`Systeme ${path} error: ${fin.status}`);
}

/** ============== SKU -> tagId (sin llamar /api/tags) ============== */
function getTagIdFromMap(sku) {
  let tagMap = {};
  try { tagMap = JSON.parse(process.env.COURSE_TAG_MAP_JSON || "{}"); } catch {}
  const raw = tagMap[sku];
  if (raw == null) throw new Error(`SKU "${sku}" no está mapeado en COURSE_TAG_MAP_JSON.`);
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) throw new Error(`COURSE_TAG_MAP_JSON debe mapear a IDs NUMÉRICOS. Valor para SKU "${sku}": "${s}".`);
  return Number(s);
}

/** ============== Contactos ============== */
async function findContactIdByEmail(email) {
  const q = encodeURIComponent(email);
  // probamos rutas con y sin /api
  const candidates = [
    `/api/contacts?email=${q}`,
    `/api/public/contacts?email=${q}`,
    `/contacts?email=${q}`,
    `/public/contacts?email=${q}`,
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

// Suscripción por formulario público (requiere SYSTEME_FALLBACK_FORM_ID)
async function subscribeViaForm({ email, first_name = "", last_name = "" }) {
  const formId = process.env.SYSTEME_FALLBACK_FORM_ID;
  if (!formId) return null;

  const bodies = [
    { body: JSON.stringify({ email, first_name, last_name }), headers: { "Content-Type": "application/json" } },
  ];
  const routes = [
    `/api/public/forms/${encodeURIComponent(formId)}/subscribe`,
    `/public/forms/${encodeURIComponent(formId)}/subscribe`,
    `/api/forms/${encodeURIComponent(formId)}/subscribe`, // por si acaso
  ];

  for (const route of routes) {
    try {
      const r = await systemeFetch(route, { method: "POST", ...bodies[0] }, { tolerate404: true });
      if (r.ok) {
        // esperar y buscar el contacto creado
        for (let i = 0; i < 3; i++) {
          await sleep(700);
          const id = await findContactIdByEmail(email);
          if (id) return id;
        }
      } else {
        console.warn("subscribeViaForm 404 en", route);
      }
    } catch (e) {
      console.warn("subscribeViaForm error", route, String(e?.message || e));
    }
  }
  console.warn("subscribeViaForm: endpoint público no disponible");
  return null;
}

async function createContact({ email, first_name = "", last_name = "" }) {
  // 1) Endpoints directos conocidos (con y sin /api)
  const candidates = [
    { path: `/api/contacts`,        body: { email, first_name, last_name } },
    { path: `/api/public/contacts`, body: { email, first_name, last_name } },
    { path: `/contacts`,            body: { email, first_name, last_name } },
    { path: `/public/contacts`,     body: { email, first_name, last_name } },
  ];
  for (const c of candidates) {
    try {
      const r = await systemeFetch(c.path, { method: "POST", body: JSON.stringify(c.body) }, { tolerate404: true });
      if (r.ok) return Number(r.json?.id);
    } catch (e) {
      console.warn("Create contact intento fallido:", c.path, String(e?.message || e));
    }
  }

  // 2) Plan B: formulario público
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
  const paths = [
    `/api/contacts/${contactId}/tags`,
    `/api/public/contacts/${contactId}/tags`,
    `/contacts/${contactId}/tags`,
    `/public/contacts/${contactId}/tags`,
  ];
  const body = JSON.stringify({ tag_id: tagId });

  for (const p of paths) {
    try {
      const r = await systemeFetch(p, { method: "POST", body }, { tolerate404: true });
      if (r.ok) return;
    } catch (e) {
      console.warn("assignTag intento fallido:", p, String(e?.message || e));
    }
  }
  throw new Error("No se pudo asignar la etiqueta al contacto en Systeme.");
}

/** ============== Handler Shopify ============== */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const raw = await readRawBody(req);

    // Verificación Shopify
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const topic      = req.headers["x-shopify-topic"];
    const shop       = req.headers["x-shopify-shop-domain"];
    if (!hmacHeader || !topic || !shop) return res.status(400).json({ error: "Bad Request" });

    if (shop !== env("SHOPIFY_SHOP_DOMAIN")) return res.status(401).json({ error: "Unauthorized" });
    const digest = crypto.createHmac("sha256", env("SHOPIFY_WEBHOOK_SECRET")).update(raw).digest("base64");
    if (!timingSafeEqual(digest, String(hmacHeader))) return res.status(401).json({ error: "Unauthorized" });

    if (topic !== "orders/paid") return res.status(200).json({ ok: true, ignored: true });

    const payload = safeJsonParse(raw);
    if (!payload) return res.status(400).json({ error: "Bad Request" });

    const email     = String(payload?.email || payload?.customer?.email || "").trim();
    const firstName = payload?.customer?.first_name || payload?.billing_address?.first_name || "";
    const lastName  = payload?.customer?.last_name  || payload?.billing_address?.last_name  || "";
    if (!email) return res.status(200).json({ ok: true, reason: "order-without-email" });

    // Tomamos el primer SKU presente
    const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
    let matchedSku = null;
    for (const li of lineItems) {
      const sku = String(li?.sku || "").trim();
      if (sku) { matchedSku = sku; break; }
    }
    if (!matchedSku) return res.status(200).json({ ok: true, reason: "order-without-sku" });

    // 1) mapear SKU -> tagId numérico
    const tagId = getTagIdFromMap(matchedSku);
    console.log("SKU", matchedSku, "→ tagId:", tagId);

    // 2) crear/obtener contacto
    const contactId = await upsertSystemeContact({ email, first_name: firstName, last_name: lastName });
    console.log("Contacto ID:", contactId);

    // 3) asignar etiqueta (tu regla ya matricula + envía email)
    await assignTagToContact(contactId, tagId);
    console.log(`Tag ${tagId} asignado a ${contactId}`);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error", err);
    // 200 para que Shopify no reintente en bucle
    return res.status(200).json({ ok: true, error: String(err?.message || err) });
  }
}
