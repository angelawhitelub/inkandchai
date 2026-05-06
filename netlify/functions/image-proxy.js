const ALLOWED_HOSTS = new Set(["cdn.shopify.com"]);
const IMAGE_MAP = require("./image-map.json");

exports.handler = async (event) => {
  try {
    const imageId = event.queryStringParameters?.i || "";
    const source = IMAGE_MAP[imageId] || "";
    const url = new URL(source);

    if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
      return { statusCode: 400, body: "Unsupported image source" };
    }

    const upstream = await fetch(url.toString(), {
      headers: {
        "user-agent": "InkAndChaiImageProxy/1.0",
        "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
    });

    if (!upstream.ok) {
      return { statusCode: upstream.status, body: "Image not available" };
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    if (!contentType.startsWith("image/")) {
      return { statusCode: 415, body: "Unsupported content type" };
    }

    const bytes = Buffer.from(await upstream.arrayBuffer());
    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=604800, s-maxage=2592000, immutable",
      },
      body: bytes.toString("base64"),
    };
  } catch (error) {
    return { statusCode: 400, body: "Invalid image request" };
  }
};
