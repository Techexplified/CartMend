import { describe, it, expect, vi, beforeEach } from "vitest";
import { PostPurchaseActionService } from "../app/services/post-purchase-action.server";
import { getOrCreateShop, updateMerchantSettings } from "../app/services/merchant-settings.server";
import prisma from "../app/db.server";

// Mock GraphQL client
vi.mock("../app/services/shopify/graphql-client.server", () => {
  return {
    createShopifyGraphQLClient: vi.fn((shop: string) => ({
      getOrder: vi.fn(async (orderGid: string) => {
        if (orderGid.includes("999999")) return null;

        const isCancelled = orderGid.includes("888888");
        const isFulfilled = orderGid.includes("777777");
        const isOld = orderGid.includes("666666");

        const createdAt = isOld
          ? new Date(Date.now() - 48 * 3600 * 1000).toISOString() // 48h ago
          : new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 mins ago

        return {
          id: orderGid,
          name: "#1045",
          email: "customer@example.com",
          currencyCode: "USD",
          createdAt,
          cancelledAt: isCancelled ? new Date().toISOString() : null,
          displayFinancialStatus: "PAID",
          displayFulfillmentStatus: isFulfilled ? "FULFILLED" : "UNFULFILLED",
          totalPriceSet: {
            shopMoney: { amount: "100.00", currencyCode: "USD" },
          },
          lineItems: {
            edges: [
              {
                node: {
                  id: "gid://shopify/LineItem/101",
                  title: "Classic Flannel Shirt",
                  quantity: 1,
                  currentQuantity: 1,
                  variant: {
                    id: "gid://shopify/ProductVariant/201",
                    title: "M / Red",
                    availableForSale: true,
                    price: "50.00",
                  },
                },
              },
              {
                node: {
                  id: "gid://shopify/LineItem/102",
                  title: "Denim Jeans",
                  quantity: 2,
                  currentQuantity: 2,
                  variant: {
                    id: "gid://shopify/ProductVariant/202",
                    title: "32 / Blue",
                    availableForSale: true,
                    price: "25.00",
                  },
                },
              },
            ],
          },
        };
      }),
      orderCancel: vi.fn(async (orderGid: string) => {
        return {
          job: { id: "gid://shopify/Job/123", done: true },
          orderCancelUserErrors: [],
        };
      }),
      setOrderEditMetafield: vi.fn().mockResolvedValue([]),
    })),
  };
});

describe("PostPurchaseActionService - Thank You Page Actions", () => {
  const testId = Date.now();
  const shopDomain = `thankyou-test-${testId}.myshopify.com`;

  beforeEach(async () => {
    await getOrCreateShop(shopDomain);
    await updateMerchantSettings(shopDomain, {
      editingEnabled: true,
      editingWindowMinutes: 180,
      cancellationEnabled: true,
      cancellationWindowMinutes: 60,
      reorderEnabled: true,
    });
  });

  describe("getAvailableActions", () => {
    it("should allow Edit, Reorder, and Cancel for a fresh, unfulfilled order", async () => {
      const orderGid = "gid://shopify/Order/1045";
      const result = await PostPurchaseActionService.getAvailableActions(shopDomain, orderGid);

      expect(result).toBeDefined();
      expect(result.order.name).toBe("#1045");
      expect(result.order.fulfillmentStatus).toBe("UNFULFILLED");

      // Edit
      expect(result.actions.edit.enabled).toBe(true);
      expect(result.actions.edit.remainingSeconds).toBeGreaterThan(0);
      expect(result.actions.edit.reason).toBeNull();

      // Reorder
      expect(result.actions.reorder.enabled).toBe(true);
      expect(result.actions.reorder.itemCount).toBe(2);

      // Cancel
      expect(result.actions.cancel.enabled).toBe(true);
      expect(result.actions.cancel.remainingSeconds).toBeGreaterThan(0);
      expect(result.actions.cancel.reason).toBeNull();
    });

    it("should disable Edit and Cancel if order has already been fulfilled", async () => {
      const fulfilledOrderGid = "gid://shopify/Order/777777";
      const result = await PostPurchaseActionService.getAvailableActions(shopDomain, fulfilledOrderGid);

      expect(result.actions.edit.enabled).toBe(false);
      expect(result.actions.edit.reason).toContain("fulfilled");

      expect(result.actions.cancel.enabled).toBe(false);
      expect(result.actions.cancel.reason).toContain("fulfillment");

      // Reorder is still allowed
      expect(result.actions.reorder.enabled).toBe(true);
    });

    it("should disable Edit and Cancel if order is already cancelled", async () => {
      const cancelledOrderGid = "gid://shopify/Order/888888";
      const result = await PostPurchaseActionService.getAvailableActions(shopDomain, cancelledOrderGid);

      expect(result.actions.edit.enabled).toBe(false);
      expect(result.actions.edit.reason).toContain("cancelled");

      expect(result.actions.cancel.enabled).toBe(false);
      expect(result.actions.cancel.reason).toContain("cancelled");
    });

    it("should disable Edit and Cancel if time windows have expired", async () => {
      const oldOrderGid = "gid://shopify/Order/666666"; // 48h ago
      const result = await PostPurchaseActionService.getAvailableActions(shopDomain, oldOrderGid);

      expect(result.actions.edit.enabled).toBe(false);
      expect(result.actions.edit.remainingSeconds).toBe(0);
      expect(result.actions.edit.reason).toContain("expired");

      expect(result.actions.cancel.enabled).toBe(false);
      expect(result.actions.cancel.remainingSeconds).toBe(0);
      expect(result.actions.cancel.reason).toContain("closed");

      // Reorder is still available anytime
      expect(result.actions.reorder.enabled).toBe(true);
    });

    it("should respect merchant settings when features are disabled", async () => {
      await updateMerchantSettings(shopDomain, {
        editingEnabled: false,
        cancellationEnabled: false,
        reorderEnabled: false,
      });

      const orderGid = "gid://shopify/Order/1045";
      const result = await PostPurchaseActionService.getAvailableActions(shopDomain, orderGid);

      expect(result.actions.edit.enabled).toBe(false);
      expect(result.actions.edit.reason).toContain("disabled");

      expect(result.actions.cancel.enabled).toBe(false);
      expect(result.actions.cancel.reason).toContain("disabled");

      expect(result.actions.reorder.enabled).toBe(false);
      expect(result.actions.reorder.reason).toContain("disabled");
    });
  });

  describe("createOrRetrieveEditSession", () => {
    it("should generate a secure customer edit URL immediately for eligible orders", async () => {
      const orderGid = "gid://shopify/Order/1045";
      const session = await PostPurchaseActionService.createOrRetrieveEditSession(shopDomain, orderGid);

      expect(session.success).toBe(true);
      expect(session.redirectUrl).toMatch(/^\/apps\/cartmend\/edit\/[a-f0-9]{64}$/);
      expect(session.remainingSeconds).toBeGreaterThan(0);
      expect(session.expiresAt).toBeDefined();
    });

    it("should reject edit session creation for fulfilled or expired orders", async () => {
      const fulfilledOrderGid = "gid://shopify/Order/777777";
      await expect(
        PostPurchaseActionService.createOrRetrieveEditSession(shopDomain, fulfilledOrderGid)
      ).rejects.toThrow(/fulfilled/);
    });
  });

  describe("buildReorderCart", () => {
    it("should build a new storefront cart permalink without modifying the original order", async () => {
      const orderGid = "gid://shopify/Order/1045";
      const reorder = await PostPurchaseActionService.buildReorderCart(shopDomain, orderGid);

      expect(reorder.success).toBe(true);
      expect(reorder.itemsCount).toBe(3); // 1 + 2
      expect(reorder.cartUrl).toBe(`https://${shopDomain}/cart/201:1,202:2`);
      expect(reorder.unavailableItems.length).toBe(0);
    });
  });

  describe("cancelOrder", () => {
    it("should perform real Shopify cancellation for eligible orders", async () => {
      const orderGid = "gid://shopify/Order/1045";
      const cancelResult = await PostPurchaseActionService.cancelOrder(shopDomain, orderGid);

      expect(cancelResult.success).toBe(true);
      expect(cancelResult.message).toContain("successfully cancelled");
      expect(cancelResult.orderId).toBe("1045");
      expect(cancelResult.cancelledAt).toBeDefined();
    });

    it("should reject cancellation if window has expired or order is fulfilled", async () => {
      const oldOrderGid = "gid://shopify/Order/666666";
      await expect(
        PostPurchaseActionService.cancelOrder(shopDomain, oldOrderGid)
      ).rejects.toThrow(/closed/);
    });
  });
});
