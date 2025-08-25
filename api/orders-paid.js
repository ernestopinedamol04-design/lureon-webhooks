import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("ok");
  }

  try {
    const shopDomain = req.headers["x-shopify-shop-domain"];
    if (shopDomain !== process.env.SHOPIFY_SHOP_DOMAIN) {
      return res.status(400).send("bad shop");
    }

    const hmac = req.headers["x-shopify-hmac-sha256"];
    const body = await getRawBody(req);

    const hash = crypto
      .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(body, "utf8")
      .digest("base64");

    if (hash !== hmac) {
      return res.status(401).send("invalid signature");
    }

    const order = JSON.parse(body.toString("utf8"));
    const email = order.email;
    if (!email) {
      return res.status(200).send("no email");
    }

    // Mapear SKUs a tags
    const tagMap = JSON.parse(process.env.COURSE_TAG_MAP_JSON || "{}");
    let tagToAdd = null;
    for (const item of order.line_items) {
      if (tagMap[item.sku]) {
        tagToAdd = tagMap[item.sku];
        break;
      }
    }

    if (!tagToAdd) {
      return res.status(200).send("no tag mapped");
    }

    // Crear/obtener contacto en Systeme
    const sysApi = "https://api.systeme.io";
    const sysHeaders = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.SYSTEME_API_KEY}`,
    };

    // Buscar contacto
    let contactId = null;
    const findRes = await fetch(`${sysApi}/contacts?email=${encodeURIComponent(email)}`, { headers: sysHeaders });
    const findData = await findRes.json();
    if (findData && findData.data && findData.data.length > 0) {
      contactId = findData.data[0].id;
    }

    if (!contactId) {
      // Crear contacto
      const createRes = await fetch(`${sysApi}/contacts`, {
        method: "POST",
        headers: sysHeaders,
        body: JSON.stringify({ email }),
      });
      const createData = await createRes.json();
      contactId = createData.id;
    }

    if (!contactId) {
      return res.status(500).send("contact error");
    }

    // Añadir tag
    const tagRes = await fetch(`${sysApi}/tags/add`, {
      method: "POST",
      headers: sysHeaders,
      body: JSON.stringify({ tag: tagToAdd, contact_id: contactId }),
    });

    if (!tagRes.ok) {
      return res.status(500).send("add tag error");
    }

    return res.status(200).send("success");
  } catch (err) {
    console.error("Handler error", err);
    return res.status(500).send("server error");
  }
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(Buffer.from(data)));
    req.on("error", reject);
  });
}
