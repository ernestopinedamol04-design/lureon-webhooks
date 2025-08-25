// api/orders-paid.js
// Vercel Serverless Function para el webhook "orders/paid" de Shopify
// Crea/actualiza contacto en Systeme y le asigna el tag del curso (por SKU)

import crypto from "crypto";

// --------- Helpers base ---------

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

async function systemeFetch(path, opts = {}) {
  const base = "https://systeme.io";
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": env("SYSTEME_API_KEY"),
      ...(opts.headers || {}),
    },
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    console.error("Systeme error", res.status, path, json);
    throw new Error(`Systeme ${path} error: ${res.status}`);
  }
  return json;
}

// --------- Lógica de tags (acepta ID o nombre) ---------

async function resolveSystemeTagId(tagValue) {
  // Si el valor son dígitos, asumimos que YA es un ID
  if (/^\d+$/.test(String(tagValue))) {
    return Number(tagValue);
  }

  const desiredName = String(tagValue).trim().toLowerCase();

  // 1) buscar por nombre (paginado simple, 100 items)
  const list = await systemeFetch(`/api/tags?perPage=100`);
  const items = Array.isArray(list?.items) ? list.items : Array.isArray(list) ? list : [];

  const found = items.find((t) => String(t?.name || "").toLowerCase() === desiredName);
  if (found?.id) {
    return Number(found.id);
  }

  // 2) crear tag
  const created = await systemeFetch(`/api/tags`, {
    method: "POST",
    body: JSON.stringify({ name: String(tagValue) }),
  });

  const tagId = Number(created?.id);
  if (!tagId) throw new Error("No se pudo crear el tag en Systeme.");
  console.log("Tag creado en Systeme:", tagId);
  return tagId;
}

// --------- Contacto en Systeme ---------

async function upsertSystemeContact({ email, first_name = "", last_name = "" }) {
  // Algunos tenants soportan POST /api/contacts como upsert.
  // Si tu cuenta no hace upsert, puedes hacer primero un GET por email.
  // Intento 1: crear/actualizar directo
  try {
    const created = await systemeFetch(`/api/contacts`, {
      method: "POST",
      body: JSON.stringify({ email, first_name, last_name }),
    });
    return Number(created?.id);
  } catch (e) {
    // Intento 2 (fallback): buscar por email y si existe usar ese id
    try {
      const q = encodeURIComponent(email);
      const search = await systemeFetch(`/api/contacts?email=${q}`);
      const items = Array.isArray(search?.items) ? search.items : Array.isArray(search) ? search : [];
      const found = items.find((c) => String(c?.email || "").toLowerCase() === email.toLowerCase());
      if (found?.id) return Number(found.id);
    } catch {}
    throw e;
  }
}

async function assignTagToContact(contactId, tagId) {
  await systemeFetch(`/api/contacts/${contactId}/tags`, {
    method: "POST",
    body: JSON.stringify({ tag_id: tagId }),
  });
}

// --------- Handler principal ---------

export default async function handler(req, res) {
  try {
    // Sólo aceptamos POST
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // 1) Leer raw body para verificar HMAC
    const raw = await readRawBody(req);

    // 2) Verificación de Shopify
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const topic = req.headers["x-shopify-topic"];
    const shop = req.headers["x-shopify-shop-domain"];

    if (!hmacHeader || !topic || !shop) {
      console.warn("Faltan headers de Shopify");
      return res.status(400).json({ error: "Bad Request" });
    }

    // Dominio esperado (mi-tienda.myshopify.com)
    const expectedShop = env("SHOPIFY_SHOP_DOMAIN");
    if (shop !== expectedShop) {
      console.warn("Shop no permitido:", shop);
      return res.status(401).json({ error: "Unauthorized" });
    }

    // HMAC
    const secret = env("SHOPIFY_WEBHOOK_SECRET");
    const digest = crypto.createHmac("sha256", secret).update(raw).digest("base64");
    if (!timingSafeEqual(digest, String(hmacHeader))) {
      console.warn("HMAC inválido");
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 3) Validar evento
    if (topic !== "orders/paid") {
      console.log("Ignorando topic:", topic);
      return res.status(200).json({ ok: true, ignored: true });
    }

    // 4) Parsear payload
    const payload = safeJsonParse(raw);
    if (!payload) {
      console.warn("Payload vacío/ inválido");
      return res.status(400).json({ error: "Bad Request" });
    }

    // 5) Extraer cliente
    const email = String(payload?.email || payload?.customer?.email || "").trim();
    const firstName = payload?.customer?.first_name || payload?.billing_address?.first_name || "";
    const lastName = payload?.customer?.last_name || payload?.billing_address?.last_name || "";

    if (!email) {
      console.log("Orden sin email; no se crea contacto.");
      return res.status(200).json({ ok: true });
    }

    // 6) Determinar SKU y tag configurado
    const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
    // Carga el mapa { "SKU": "tagName|tagId" }
    let tagMap = {};
    try {
      tagMap = JSON.parse(process.env.COURSE_TAG_MAP_JSON || "{}");
    } catch {
      tagMap = {};
    }

    // Buscar la primera línea cuyo SKU exista en el mapa
    let matchedSku = null;
    for (const li of lineItems) {
      const sku = String(li?.sku || "").trim();
      if (sku && tagMap[sku]) {
        matchedSku = sku;
        break;
      }
    }

    if (!matchedSku) {
      console.log("No hay SKU con tag configurado en esta orden. Nada que hacer.");
      return res.status(200).json({ ok: true });
    }

    const tagValue = tagMap[matchedSku]; // puede ser "lureon" o "1616892"
    console.log("SKU detectado:", matchedSku, "→ tag configurado:", tagValue);

    // 7) Resolver ID de tag (ID directo o por nombre)
    const tagId = await resolveSystemeTagId(tagValue);
    console.log("Usando tagId:", tagId);

    // 8) Upsert contacto en Systeme
    const contactId = await upsertSystemeContact({
      email,
      first_name: firstName || "",
      last_name: lastName || "",
    });
    console.log("Contacto Systeme id:", contactId);

    // 9) Asignar tag (dispara tu automatización en Systeme)
    await assignTagToContact(contactId, tagId);
    console.log(`Tag ${tagId} asignado a contacto ${contactId}`);

    // 10) Listo
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error", err);
    return res.status(200).json({ ok: true, error: String(err?.message || err) });
    // Respondemos 200 para que Shopify no reintente indefinidamente.
  }
}
