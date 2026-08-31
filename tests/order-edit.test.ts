import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import prisma from "../app/db.server";
import {
  createEditSession,
  validateAndGetSession,
  validatePermissionsForChanges,
  cancelEditSession,
  commitOrderEdit,
  previewOrderEdit,
} from "../app/services/order-edit.server";
import { updateMerchantSettings, getOrCreateShop } from "../app/services/merchant-settings.server";
import {
  EditSessionNotFound,
  EditSessionExpired,
  EditSessionAlreadyCompleted,
  MerchantPermissionDenied,
} from "../app/services/errors";
import { EditSessionStatus } from "@prisma/client";

// Mock createShopifyGraphQLClient for controlled unit/integration testing of financial paths
let currentMockPrice = "100.00";

vi.mock("../app/services/shopify/graphql-client.server", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    createShopifyGraphQLClient: vi.fn((shop: string) => {
      return {
        getOrder: vi.fn().mockResolvedValue({
          id: "gid://shopify/Order/99999",
          name: "#99999",
          currencyCode: "USD",
          totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
          subtotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
          invoiceUrl: "https://checkout.shopify.com/orders/99999/invoice",
          lineItems: {
            edges: [
              {
                node: {
                  id: "gid://shopify/LineItem/101",
                  title: "Classic Cotton T-Shirt",
                  quantity: 1,
                  originalUnitPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
                  variant: { id: "gid://shopify/ProductVariant/201" },
                },
              },
            ],
          },
        }),
        orderEditBegin: vi.fn().mockImplementation(() => {
          currentMockPrice = "100.00";
          return Promise.resolve({
            id: "gid://shopify/CalculatedOrder/calc_123",
            totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
            subtotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
            lineItems: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/CalculatedLineItem/calc_item_101",
                    title: "Classic Cotton T-Shirt",
                    quantity: 1,
                  },
                },
              ],
            },
          });
        }),
        orderEditSetQuantity: vi.fn().mockImplementation((id: string, lineItemId: string, qty: number) => {
          currentMockPrice = qty === 2 ? "200.00" : qty === 0 ? "0.00" : "100.00";
          return Promise.resolve({
            calculatedOrder: {
              id,
              totalPriceSet: { shopMoney: { amount: currentMockPrice, currencyCode: "USD" } },
              subtotalPriceSet: { shopMoney: { amount: currentMockPrice, currencyCode: "USD" } },
              lineItems: { edges: [] },
            },
          });
        }),
        orderEditAddVariant: vi.fn().mockImplementation((id: string, variantId: string, qty: number) => {
          currentMockPrice = "150.00";
          return Promise.resolve({
            calculatedOrder: {
              id: "gid://shopify/CalculatedOrder/calc_123",
              totalPriceSet: { shopMoney: { amount: "150.00", currencyCode: "USD" } },
            },
          });
        }),
        orderEditCommit: vi.fn().mockImplementation((id: string) => {
          return Promise.resolve({
            id: "gid://shopify/Order/99999",
            name: "#99999",
            invoiceUrl: "https://checkout.shopify.com/orders/99999/invoice",
            totalPriceSet: { shopMoney: { amount: currentMockPrice, currencyCode: "USD" } },
          });
        }),
        getOrderTransactions: vi.fn().mockResolvedValue({
          id: "gid://shopify/Order/99999",
          invoiceUrl: "https://checkout.shopify.com/orders/99999/invoice",
          transactions: [
            {
              id: "gid://shopify/OrderTransaction/tx_cap_123",
              kind: "CAPTURE",
              status: "SUCCESS",
              gateway: "shopify_payments",
              amountSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
            },
          ],
        }),
        refundCreate: vi.fn().mockResolvedValue({
          id: "gid://shopify/Refund/ref_99999",
          totalRefundedSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
        }),
        orderCancel: vi.fn().mockResolvedValue({
          orderCancelUserErrors: [],
        }),
        sendOrderInvoice: vi.fn().mockResolvedValue({ id: "gid://shopify/Order/99999" }),
        updateOrderShippingAddress: vi.fn().mockResolvedValue({ id: "gid://shopify/Order/99999" }),
        setOrderEditMetafield: vi.fn().mockResolvedValue([]),
      };
    }),
  };
});

describe("Order Edit Financial Service", () => {
  const shopDomain = `order-edit-test-${Date.now()}.myshopify.com`;

  beforeEach(async () => {
    await getOrCreateShop(shopDomain);
    await updateMerchantSettings(shopDomain, {
      editingEnabled: true,
      editingWindowMinutes: 30,
      allowQuantityChange: true,
      allowVariantChange: true,
      allowAddProduct: true,
      allowRemoveProduct: true,
      allowAddressChange: true,
      requirePaymentForDifference: true,
      allowRefundForDifference: true,
    });
  });

  afterAll(async () => {
    // Clean up all tested data from database
    try {
      const shop = await prisma.shop.findUnique({ where: { shopDomain } });
      if (shop) {
        await prisma.shop.delete({ where: { id: shop.id } });
      }
    } catch (e) {
      console.warn("Cleanup warning:", e);
    }
  });

  it("should return null if editing is disabled by merchant", async () => {
    await updateMerchantSettings(shopDomain, { editingEnabled: false });

    const result = await createEditSession({
      shopDomain,
      orderData: {
        id: "99001",
        name: "#99001",
        email: "customer@example.com",
        totalPrice: 150.0,
        createdAt: new Date(),
      },
    });

    expect(result).toBeNull();
  });

  it("should create a secure edit session with expiration and token hash when enabled", async () => {
    const orderCreatedAt = new Date();
    const result = await createEditSession({
      shopDomain,
      orderData: {
        id: "99002",
        name: "#99002",
        email: "customer@example.com",
        currency: "USD",
        totalPrice: 200.0,
        createdAt: orderCreatedAt,
      },
    });

    expect(result).toBeDefined();
    expect(result?.rawToken).toBeDefined();
    expect(result?.rawToken).toHaveLength(64);
    expect(result?.editUrl).toContain(result?.rawToken);

    // Verify session in database
    const session = await prisma.orderEditSession.findUnique({
      where: { id: result!.sessionId },
      include: { events: true, order: true },
    });

    expect(session).toBeDefined();
    expect(session?.status).toBe(EditSessionStatus.ACTIVE);
    expect(session?.originalTotal).toBe(200.0);
    // Raw token is NEVER stored in database
    expect(session?.tokenHash).not.toEqual(result?.rawToken);
    expect(session?.tokenHash).toHaveLength(64);

    // Verify expiration calculation: orderCreatedAt + 30 mins
    const expectedExpiry = new Date(orderCreatedAt.getTime() + 30 * 60 * 1000);
    expect(Math.abs(session!.expiresAt.getTime() - expectedExpiry.getTime())).toBeLessThan(5000);

    // Verify audit event
    expect(session?.events.some((e) => e.eventType === "SESSION_CREATED")).toBe(true);
  });

  it("should successfully retrieve active session using valid raw token", async () => {
    const created = await createEditSession({
      shopDomain,
      orderData: {
        id: "99003",
        name: "#99003",
        email: "alice@example.com",
        totalPrice: 85.0,
        createdAt: new Date(),
      },
    });

    const session = await validateAndGetSession(created!.rawToken);
    expect(session).toBeDefined();
    expect(session.order.shopifyOrderId).toBe("99003");
    expect(session.status).toBe(EditSessionStatus.ACTIVE);
  });

  it("should reject non-existent token with EditSessionNotFound (404)", async () => {
    const fakeToken = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    await expect(validateAndGetSession(fakeToken)).rejects.toThrow(EditSessionNotFound);
  });

  it("should reject expired session with EditSessionExpired (HTTP 410)", async () => {
    const pastDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const created = await createEditSession({
      shopDomain,
      orderData: {
        id: "99004",
        name: "#99004",
        email: "bob@example.com",
        totalPrice: 120.0,
        createdAt: new Date(),
      },
    });

    await prisma.orderEditSession.update({
      where: { id: created!.sessionId },
      data: { expiresAt: pastDate },
    });

    await expect(validateAndGetSession(created!.rawToken)).rejects.toThrow(EditSessionExpired);

    const updated = await prisma.orderEditSession.findUnique({
      where: { id: created!.sessionId },
    });
    expect(updated?.status).toBe(EditSessionStatus.EXPIRED);
  });

  it("should reject already completed session with EditSessionAlreadyCompleted (409)", async () => {
    const created = await createEditSession({
      shopDomain,
      orderData: {
        id: "99005",
        name: "#99005",
        email: "charlie@example.com",
        totalPrice: 50.0,
        createdAt: new Date(),
      },
    });

    await prisma.orderEditSession.update({
      where: { id: created!.sessionId },
      data: { status: EditSessionStatus.COMPLETED, finalTotal: 75.0 },
    });

    await expect(validateAndGetSession(created!.rawToken)).rejects.toThrow(EditSessionAlreadyCompleted);
  });

  it("should enforce merchant permissions against customer changes", () => {
    const restrictedSettings = {
      allowQuantityChange: false,
      allowVariantChange: false,
      allowAddProduct: false,
      allowRemoveProduct: false,
      allowAddressChange: false,
    };

    expect(() =>
      validatePermissionsForChanges(restrictedSettings, {
        quantityChanges: [{ lineItemId: "gid://shopify/LineItem/1", quantity: 3 }],
      })
    ).toThrow(MerchantPermissionDenied);
  });

  it("should allow cancelling an active edit session", async () => {
    const created = await createEditSession({
      shopDomain,
      orderData: {
        id: "99006",
        name: "#99006",
        email: "dave@example.com",
        totalPrice: 90.0,
        createdAt: new Date(),
      },
    });

    const cancelResult = await cancelEditSession(created!.rawToken);
    expect(cancelResult.success).toBe(true);
    expect(cancelResult.status).toBe("CANCELLED");

    const session = await prisma.orderEditSession.findUnique({
      where: { id: created!.sessionId },
    });
    expect(session?.status).toBe(EditSessionStatus.CANCELLED);
    expect(session?.cancelledAt).toBeDefined();
  });

  it("should execute financial flow for Same Price edit (Status: COMPLETED, no payment, no refund)", async () => {
    const created = await createEditSession({
      shopDomain,
      orderData: {
        id: "99007",
        name: "#99007",
        email: "sameprice@example.com",
        totalPrice: 100.0,
        createdAt: new Date(),
      },
    });

    const commitResult = await commitOrderEdit(created!.rawToken, {
      shippingAddress: {
        address1: "456 Market St",
        city: "San Francisco",
        province: "CA",
        zip: "94105",
      },
    });

    expect(commitResult.success).toBe(true);
    expect(commitResult.status).toBe("COMPLETED");
    expect(commitResult.difference).toBe(0);

    const session = await prisma.orderEditSession.findUnique({
      where: { id: created!.sessionId },
    });
    expect(session?.status).toBe(EditSessionStatus.COMPLETED);
    expect(session?.paymentStatus).toBe("NONE");
    expect(session?.refundStatus).toBe("NONE");
  });

  it("should calculate exact preview from Shopify CalculatedOrder", async () => {
    const created = await createEditSession({
      shopDomain,
      orderData: {
        id: "99008",
        name: "#99008",
        email: "preview@example.com",
        totalPrice: 100.0,
        createdAt: new Date(),
      },
    });

    const previewResult = await previewOrderEdit(created!.rawToken, {
      quantityChanges: [{ lineItemId: "gid://shopify/LineItem/101", quantity: 2 }],
    });

    expect(previewResult).toBeDefined();
    expect(previewResult.calculatedTotal).toBe(200.0);
    expect(previewResult.originalTotal).toBe(100.0);
    expect(previewResult.difference).toBe(100.0);
    expect(previewResult.paymentRequired).toBe(true);
    expect(previewResult.refundExpected).toBe(false);
  });

  it("should handle Price Increase financial flow (Status: PAYMENT_REQUIRED, with Shopify invoiceUrl)", async () => {
    const created = await createEditSession({
      shopDomain,
      orderData: {
        id: "99009",
        name: "#99009",
        email: "increase@example.com",
        totalPrice: 100.0,
        createdAt: new Date(),
      },
    });

    // Mock commit returning higher total
    const commitResult = await commitOrderEdit(created!.rawToken, {
      quantityChanges: [{ lineItemId: "gid://shopify/LineItem/101", quantity: 2 }],
    });

    expect(commitResult.status).toBe("PAYMENT_REQUIRED");
    expect(commitResult.amountDue).toBeDefined();

    const session = await prisma.orderEditSession.findUnique({
      where: { id: created!.sessionId },
    });
    expect(session?.status).toBe(EditSessionStatus.PAYMENT_REQUIRED);
    expect(session?.paymentStatus).toBe("REQUIRED");
  });

  it("should handle Price Decrease financial flow (Status: COMPLETED, refund issued with refundId)", async () => {
    const created = await createEditSession({
      shopDomain,
      orderData: {
        id: "99010",
        name: "#99010",
        email: "decrease@example.com",
        totalPrice: 100.0,
        createdAt: new Date(),
      },
    });

    // Removing item reduces price to $0
    const commitResult = await commitOrderEdit(created!.rawToken, {
      removedLineItems: [{ lineItemId: "gid://shopify/LineItem/101" }],
    });

    expect(commitResult.success).toBe(true);
    expect(commitResult.status).toBe("COMPLETED");
    expect(commitResult.refundId).toBe("gid://shopify/Refund/ref_99999");
    expect(commitResult.refundAmount).toBe(100.0);

    const session = await prisma.orderEditSession.findUnique({
      where: { id: created!.sessionId },
    });
    expect(session?.status).toBe(EditSessionStatus.COMPLETED);
    expect(session?.refundStatus).toBe("COMPLETED");
    expect(session?.refundId).toBe("gid://shopify/Refund/ref_99999");
    expect(session?.idempotencyKey).toBeDefined();
  });

  it("should be idempotent when repeating commit on an already completed session", async () => {
    const created = await createEditSession({
      shopDomain,
      orderData: {
        id: "99011",
        name: "#99011",
        email: "idempotent@example.com",
        totalPrice: 100.0,
        createdAt: new Date(),
      },
    });

    // First commit
    const res1 = await commitOrderEdit(created!.rawToken, {
      shippingAddress: { city: "Boston" },
    });
    expect(res1.status).toBe("COMPLETED");

    // Second commit (idempotent retry)
    const res2 = await commitOrderEdit(created!.rawToken, {
      shippingAddress: { city: "Boston" },
    });
    expect(res2.success).toBe(true);
    expect(res2.status).toBe("COMPLETED");
    expect(res2.total).toBe(res1.total);
  });
});

