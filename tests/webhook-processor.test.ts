import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../app/db.server";
import { processShopifyWebhook } from "../app/services/webhook-processor.server";
import { updateMerchantSettings, getOrCreateShop } from "../app/services/merchant-settings.server";
import { EditSessionStatus } from "@prisma/client";

describe("Webhook Processor Service", () => {
  const shopDomain = `webhook-test-${Date.now()}.myshopify.com`;

  beforeEach(async () => {
    await getOrCreateShop(shopDomain);
    await updateMerchantSettings(shopDomain, {
      editingEnabled: true,
      editingWindowMinutes: 60,
    });
  });

  it("should process orders/create webhook and create an active edit session", async () => {
    const webhookId = "webhook_orders_create_101";
    const payload = {
      id: 554433,
      admin_graphql_api_id: "gid://shopify/Order/554433",
      name: "#1050",
      email: "webhook_customer@example.com",
      currency: "USD",
      total_price: "125.00",
      created_at: new Date().toISOString(),
    };

    const result = await processShopifyWebhook({
      shopDomain,
      topic: "orders/create",
      shopifyWebhookId: webhookId,
      payload,
    });

    expect(result.processed).toBe(true);

    // Verify order was created in DB
    const order = await prisma.order.findFirst({
      where: { shopifyOrderId: "554433" },
      include: { editSessions: true },
    });

    expect(order).toBeDefined();
    expect(order?.shopifyOrderName).toBe("#1050");
    expect(order?.originalTotal).toBe(125.0);
    expect(order?.editSessions).toHaveLength(1);
    expect(order?.editSessions[0].status).toBe(EditSessionStatus.ACTIVE);
  });

  it("should enforce idempotency and ignore duplicate webhook requests", async () => {
    const webhookId = `webhook_duplicate_test_${Date.now()}`;
    const payload = {
      id: 778899,
      admin_graphql_api_id: "gid://shopify/Order/778899",
      name: "#1051",
      email: "duplicate@example.com",
      total_price: "50.00",
      created_at: new Date().toISOString(),
    };

    // First call
    const firstResult = await processShopifyWebhook({
      shopDomain,
      topic: "orders/create",
      shopifyWebhookId: webhookId,
      payload,
    });
    expect(firstResult.processed).toBe(true);

    // Second duplicate call
    const secondResult = await processShopifyWebhook({
      shopDomain,
      topic: "orders/create",
      shopifyWebhookId: webhookId,
      payload,
    });

    expect(secondResult.duplicate).toBe(true);
    expect(secondResult.processed).toBe(true);

    // Verify only ONE order and ONE webhook event exists for this shop
    const events = await prisma.webhookEvent.findMany({
      where: { shopifyWebhookId: webhookId },
    });
    expect(events).toHaveLength(1);
  });

  it("should handle orders/updated and expire edit session if fulfilled", async () => {
    // 1. Create order and session via orders/create
    const webhookIdCreate = "webhook_order_fulfill_test_1";
    await processShopifyWebhook({
      shopDomain,
      topic: "orders/create",
      shopifyWebhookId: webhookIdCreate,
      payload: {
        id: 991122,
        name: "#1052",
        email: "fulfill@example.com",
        total_price: "75.00",
        fulfillment_status: null,
        created_at: new Date().toISOString(),
      },
    });

    // 2. Send orders/updated with fulfilled status
    const webhookIdUpdate = "webhook_order_fulfill_test_2";
    await processShopifyWebhook({
      shopDomain,
      topic: "orders/updated",
      shopifyWebhookId: webhookIdUpdate,
      payload: {
        id: 991122,
        name: "#1052",
        total_price: "75.00",
        fulfillment_status: "fulfilled",
      },
    });

    // 3. Verify session was updated to EXPIRED
    const order = await prisma.order.findFirst({
      where: { shopifyOrderId: "991122" },
      include: { editSessions: true },
    });

    expect(order?.fulfillmentStatus).toBe("fulfilled");
    expect(order?.editSessions[0].status).toBe(EditSessionStatus.EXPIRED);
  });

  it("should handle app/uninstalled webhook and record uninstallation", async () => {
    const webhookId = "webhook_uninstalled_999";
    await processShopifyWebhook({
      shopDomain,
      topic: "app/uninstalled",
      shopifyWebhookId: webhookId,
      payload: {},
    });

    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
    });

    expect(shop?.uninstalledAt).toBeDefined();
  });
});
