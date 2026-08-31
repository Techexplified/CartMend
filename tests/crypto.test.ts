import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  generateCustomerToken,
  hashToken,
  verifyAppProxyHmac,
  verifyWebhookHmac,
} from "../app/services/crypto.server";

describe("Crypto Service", () => {
  it("should generate a 64-character hex cryptographically secure token", () => {
    const token1 = generateCustomerToken();
    const token2 = generateCustomerToken();

    expect(token1).toHaveLength(64);
    expect(token2).toHaveLength(64);
    expect(token1).not.toEqual(token2);
    expect(/^[0-9a-f]{64}$/.test(token1)).toBe(true);
  });

  it("should generate consistent SHA-256 hash for raw tokens", () => {
    const rawToken = "a1b2c3d4e5f678901234567890abcdef1234567890abcdef1234567890abcdef";
    const expectedHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const hash = hashToken(rawToken);
    expect(hash).toBe(expectedHash);
    expect(hash).toHaveLength(64);
  });

  it("should throw when hashing empty or invalid tokens", () => {
    expect(() => hashToken("")).toThrow("Invalid token");
    expect(() => hashToken(null as any)).toThrow("Invalid token");
  });

  it("should verify valid Shopify App Proxy HMAC signature", () => {
    const apiSecret = "test_shopify_secret_key_123";
    const params = new URLSearchParams({
      shop: "test-store.myshopify.com",
      path_prefix: "/apps/cartmend",
      timestamp: "1724330000",
    });

    // Compute expected signature: sorted keys -> "path_prefix=/apps/cartmendshop=test-store.myshopify.comtimestamp=1724330000"
    const message = "path_prefix=/apps/cartmendshop=test-store.myshopify.comtimestamp=1724330000";
    const signature = crypto.createHmac("sha256", apiSecret).update(message).digest("hex");
    params.set("signature", signature);

    expect(verifyAppProxyHmac(params, apiSecret)).toBe(true);
  });

  it("should reject tampered or invalid Shopify App Proxy HMAC signature", () => {
    const apiSecret = "test_shopify_secret_key_123";
    const params = new URLSearchParams({
      shop: "test-store.myshopify.com",
      path_prefix: "/apps/cartmend",
      timestamp: "1724330000",
      signature: "invalid_hex_signature_0000000000000000000000000000000000000000000000",
    });

    expect(verifyAppProxyHmac(params, apiSecret)).toBe(false);
  });

  it("should verify valid Shopify Webhook HMAC header", () => {
    const apiSecret = "test_webhook_secret_key_456";
    const rawBody = JSON.stringify({ id: 123456, name: "#1001" });
    const hmacHeader = crypto.createHmac("sha256", apiSecret).update(rawBody).digest("base64");

    expect(verifyWebhookHmac(rawBody, hmacHeader, apiSecret)).toBe(true);
    expect(verifyWebhookHmac(rawBody, "invalid_hmac_header", apiSecret)).toBe(false);
  });
});
