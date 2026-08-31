import crypto from "node:crypto";

/**
 * Generate a cryptographically secure random token (64 hex characters / 32 bytes).
 */
export function generateCustomerToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Hash customer token using SHA-256. Only this hash is stored in PostgreSQL.
 */
export function hashToken(rawToken: string): string {
  if (!rawToken || typeof rawToken !== "string") {
    throw new Error("Invalid token provided for hashing");
  }
  return crypto.createHash("sha256").update(rawToken.trim()).digest("hex");
}

/**
 * Verifies Shopify App Proxy HMAC signature to ensure the request is routed securely via Shopify.
 */
export function verifyAppProxyHmac(
  queryParams: URLSearchParams | Record<string, string | string[]>,
  apiSecret: string
): boolean {
  if (!apiSecret) {
    return false;
  }

  const params: Record<string, string> = {};
  let providedSignature = "";

  if (queryParams instanceof URLSearchParams) {
    for (const [key, value] of queryParams.entries()) {
      if (key === "signature") {
        providedSignature = value;
      } else {
        params[key] = value;
      }
    }
  } else {
    for (const [key, value] of Object.entries(queryParams)) {
      if (key === "signature") {
        providedSignature = Array.isArray(value) ? value[0] : value;
      } else {
        params[key] = Array.isArray(value) ? value.join(",") : value;
      }
    }
  }

  if (!providedSignature) {
    return false;
  }

  // Sort keys alphabetically and construct string
  const sortedKeys = Object.keys(params).sort();
  const message = sortedKeys.map((k) => `${k}=${params[k]}`).join("");

  const computedSignature = crypto
    .createHmac("sha256", apiSecret)
    .update(message)
    .digest("hex");

  try {
    const signatureBuffer = Buffer.from(providedSignature, "utf-8");
    const computedBuffer = Buffer.from(computedSignature, "utf-8");

    if (signatureBuffer.length !== computedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(signatureBuffer, computedBuffer);
  } catch {
    return false;
  }
}

/**
 * Verifies standard Shopify Webhook HMAC-SHA256 header.
 */
export function verifyWebhookHmac(
  rawBody: string | Buffer,
  hmacHeader: string,
  apiSecret: string
): boolean {
  if (!hmacHeader || !apiSecret) {
    return false;
  }

  const computedHmac = crypto
    .createHmac("sha256", apiSecret)
    .update(rawBody)
    .digest("base64");

  try {
    const headerBuffer = Buffer.from(hmacHeader, "utf-8");
    const computedBuffer = Buffer.from(computedHmac, "utf-8");

    if (headerBuffer.length !== computedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(headerBuffer, computedBuffer);
  } catch {
    return false;
  }
}
