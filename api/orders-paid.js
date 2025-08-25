import crypto from "crypto";

async function readRaw(req){
  const chunks=[]; for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function systeme(path, {method="GET", headers={}, body}={}, tries=2){
  const url = `https://api.systeme.io${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      "X-API-Key": process.env.SYSTEME_API_KEY,
      "Authorization": `Bearer ${process.env.SYSTEME_API_KEY}`,
      "Accept": "application/json",
      ...headers
    },
    body
  });

  // reintenta si 5xx / 429
  if ((resp.status === 429 || resp.status >= 500) && tries > 0){
    const retryAfter = Number(resp.headers.get("Retry-After") || 1);
    await new Promise(r => setTimeout(r, retryAfter*1000));
    return systeme(path, {method, headers, body}, tries-1);
  }
  return resp;
}

// parsea JSON con fallback a texto (para logs de error)
async function safeJson(resp){
  const txt = await resp.text();
  try { return { json: JSON.parse(txt), text: txt }; }
  catch { return { json: null, text: txt }; }
}

// Busca tag por nombre; si no existe, lo crea y devuelve su ID
async function ensureTagIdByName(name){
  if (!name) return null;

  // 1) listar tags (forma amplia)
  let r = await systeme(`/api/tags?limit=200`);
  if (r.ok){
    const { json } = await safeJson(r);
    const arr = (json?.items) || (json?.data) || (json?.tags) || [];
    const hit = arr.find(t => String(t?.name || "").toLowerCase() === String(name).toLowerCase());
    if (hit?.id) return hit.id;
  } else {
    const { text } = await safeJson(r);
    console.error("Systeme /api/tags error:", r.status, text.slice(0,300));
  }

  // 2) intento GET filtrando por nombre (algunas cuentas lo soportan)
  r = await systeme(`/api/tags?name=${encodeURIComponent(name)}`);
  if (r.ok){
    const { json } = await safeJson(r);
    const arr = (json?.items) || (json?.data) || (json?.tags) || [];
    const hit = arr.find(t => String(t?.name || "").toLowerCase() === String(name).toLowerCase());
    if (hit?.id) return hit.id;
  }

  // 3) crear tag si no existe
  const create = await systeme(`/api/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!create.ok){
    const { text } = await safeJson(create);
    console.error("Systeme POST /api/tags error:", create.status, text.slice(0,300));
    return null;
  }
  const { json: created } = await safeJson(create);
  return created?.id || null;
}

export default async function handler(req, res){
  if (req.method !== "POST") return res.status(200).send("ok");

  // 1) tienda
  const shop = (req.headers["x-shopify-shop-domain"] || "").toLowerCase();
  if (shop !== (process.env.SHOPIFY_SHOP_DOMAIN || "").toLowerCase()){
    return res.status(400).send("bad shop");
  }

  // 2) HMAC
  const raw = await readRaw(req);
  const theirHmac = req.headers["x-shopify-hmac-sha256"] || "";
  const digest = crypto.createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET).update(raw).digest("base64");
  if (!timingSafeEq(digest, theirHmac)) return res.status(401).send("invalid signature");

  // 3) orden
  let order; try{ order = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).send("json"); }
  const email = order.email || order.customer?.email;
  const firstName = order.customer?.first_name || order.billing_address?.first_name || "";
  const lastName  = order.customer?.last_name  || order.billing_address?.last_name  || "";
  if (!email) return res.status(200).send("no email");

  // 4) map SKU -> tag name
  const tagNames = new Set();
  try{
    const MAP = JSON.parse(process.env.COURSE_TAG_MAP_JSON || "{}"); // {"001":"lureon"}
    for (const li of (order.line_items || [])){
      const key = li.sku || String(li.product_id || "") || String(li.variant_id || "");
      if (MAP[key]) tagNames.add(MAP[key]);
    }
  }catch{}
  if (!tagNames.size) return res.status(200).send("no tag mapped");

  try{
    // 5) crear/obtener contacto
    let contactId = null;

    // crear
    let create = await systeme("/api/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, firstName, lastName })
    });

    if (!create.ok){
      // buscar por email si ya existía
      const q = await systeme(`/api/contacts?email=${encodeURIComponent(email)}`);
      if (!q.ok){
        const { text } = await safeJson(q);
        console.error("Systeme GET /api/contacts error:", q.status, text.slice(0,300));
        return res.status(500).send("contact");
      }
      const { json } = await safeJson(q);
      const arr = (json?.items) || (json?.data) || (json?.contacts) || [];
      const found = arr.find(c => (c?.email || "").toLowerCase() === email.toLowerCase());
      contactId = found?.id || null;
    } else {
      const { json } = await safeJson(create);
      contactId = json?.id || null;
    }
    if (!contactId) return res.status(500).send("contact");

    // 6) asegurar tag (buscar o crear) y asignar
    for (const name of tagNames){
      const tagId = await ensureTagIdByName(name);
      if (!tagId) {
        console.error("Tag no encontrado/creado:", name);
        continue;
      }
      const add = await systeme(`/api/contacts/${contactId}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tagId })
      });
      if (!add.ok){
        const { text } = await safeJson(add);
        console.error("Systeme POST add tag error:", add.status, text.slice(0,300));
      }
    }

    return res.status(200).send("ok");
  }catch(e){
    console.error("Handler error", e);
    return res.status(500).send("fail");
  }
}

function timingSafeEq(a,b){
  const A = Buffer.from(a || "");
  const B = Buffer.from(b || "");
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A,B);
}
