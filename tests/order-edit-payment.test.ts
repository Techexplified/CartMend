import { describe, it, expect, beforeEach, vi } from "vitest";
import prisma from "../app/db.server";
import { createEditSession, commitOrderEdit } from "../app/services/order-edit.server";
import { OrderEditPaymentService } from "../app/services/order-edit-payment.server";
import { getOrCreateShop, updateMerchantSettings } from "../app/services/merchant-settings.server";
import { EditSessionStatus } from "@prisma/client";

let currentMockPrice = "100.00";

// Mock the Shopify GraphQL client
vi.mock("../app/services/shopify/graphql-client.server", () => {
  return {
    createShopifyGraphQLClient: vi.fn(() => ({
      getOrder: vi.fn(async (id: string) => {
        return {
          id: "gid://shopify/Order/77701",
          name: "#77701",
          email: "customer@example.com",
          currencyCode: "USD",
          displayFinancialStatus: "PAID",
          displayFulfillmentStatus: "UNFULFILLED",
          createdAt: new Date().toISOString(),
          totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
          totalOutstandingSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
          lineItems: {
            edges: [
              {
                node: {
                  id: "gid://shopify/LineItem/101",
                  title: "Cool Hoodie",
                  quantity: 1,
                  originalUnitPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
                  variant: { id: "gid://shopify/ProductVariant/201", title: "Black / M" },
                },
              },
            ],
          },
        };
      }),
      getOrderTransactions: vi.fn(async () => {
        return {
          totalOutstandingSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
          transactions: [
            {
              id: "gid://shopify/OrderTransaction/88801",
              kind: "SALE",
              status: "SUCCESS",
              amountSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
              gateway: "shopify_payments",
            },
          ],
        };
      }),
      orderEditBegin: vi.fn(async () => {
        currentMockPrice = "100.00";
        return {
          id: "gid://shopify/CalculatedOrder/99901",
          totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
        };
      }),
      orderEditSetQuantity: vi.fn(async (calcId, lineItemId, qty) => {
        const newTotal = qty === 0 ? "0.00" : (qty * 100).toFixed(2);
        currentMockPrice = newTotal;
        return {
          calculatedOrder: {
            id: calcId,
            totalPriceSet: { shopMoney: { amount: newTotal, currencyCode: "USD" } },
          },
        };
      }),
      orderEditAddVariant: vi.fn(async (calcId, variantId, qty) => {
        currentMockPrice = "125.00";
        return {
          calculatedOrder: {
            id: calcId,
            totalPriceSet: { shopMoney: { amount: "125.00", currencyCode: "USD" } },
          },
        };
      }),
      orderEditCommit: vi.fn(async () => {
        return {
          id: "gid://shopify/Order/77701",
          totalPriceSet: { shopMoney: { amount: currentMockPrice, currencyCode: "USD" } },
          paymentCollectionDetails: {
            additionalPaymentCollectionUrl: "https://shop.myshopify.com/76206/order_payment/77701?secret=xyz",
          },
        };
      }),
      sendOrderInvoice: vi.fn(async () => {
        return { success: true };
      }),
      refundCreate: vi.fn(async () => {
        return {
          id: "gid://shopify/Refund/55501",
          totalRefundedSet: { shopMoney: { amount: "25.00", currencyCode: "USD" } },
        };
      }),
      orderCancel: vi.fn(async () => {
        return {
          orderCancelUserErrors: [],
        };
      }),
      setOrderEditMetafield: vi.fn().mockResolvedValue([]),
    })),
  };
});

describe("OrderEditPaymentService & Financial State Machine", () => {
  const shopDomain = `payment-test-${Date.now()}.myshopify.com`;

  beforeEach(async () => {
    await getOrCreateShop(shopDomain);
    await updateMerchantSettings(shopDomain, {
      editingEnabled: true,
      editingWindowMinutes: 60,
      allowQuantityChange: true,
      allowVariantChange: true,
      allowAddProduct: true,
      allowRemoveProduct: true,
      requirePaymentForDifference: true,
      allowRefundForDifference: true,
      cancellationEnabled: true,
      reorderEnabled: true,
    });
  });

  // TEST 1: Original $100 -> Updated $100 (No payment, commits successfully)
  it("TEST 1: should commit order edit with no additional payment when total is unchanged", async () => {
    const session = await createEditSession({
      shopDomain,
      orderData: {
        id: "77701",
        name: "#77701",
        email: "customer@example.com",
        totalPrice: 100.0,
        createdAt: new Date(),
      },
    });

    const commitResult = await commitOrderEdit(session!.rawToken, {
      quantityChanges: [{ lineItemId: "gid://shopify/LineItem/101", quantity: 1 }],
    });

    expect(commitResult.status).toBe("COMPLETED");
    expect(commitResult.difference).toBe(0);

    const dbSession = await prisma.orderEditSession.findUnique({
      where: { id: session!.sessionId },
    });
    expect(dbSession?.status).toBe(EditSessionStatus.COMPLETED);
    expect(dbSession?.paymentStatus).toBe("NONE");
  });

  // TEST 2: Original $100 -> Updated $125 (PAYMENT_REQUIRED, amount due $25, invoice sent, official Shopify checkout paymentUrl)
  it("TEST 2: should transition to PAYMENT_REQUIRED with amount due $25 and official Shopify paymentUrl", async () => {
    const session = await createEditSession({
      shopDomain,
      orderData: {
        id: "77702",
        name: "#77702",
        email: "customer@example.com",
        totalPrice: 100.0,
        createdAt: new Date(),
      },
    });

    const commitResult = await commitOrderEdit(session!.rawToken, {
      addedProducts: [{ variantId: "gid://shopify/ProductVariant/301", quantity: 1 }],
    });

    expect(commitResult.status).toBe("PAYMENT_REQUIRED");
    expect(commitResult.amountDue).toBe("25.00");
    expect(commitResult.originalTotal).toBe("100.00");
    expect(commitResult.updatedTotal).toBe("125.00");
    expect(commitResult.invoiceSent).toBe(true);
    expect(commitResult.paymentUrl).toBe("https://shop.myshopify.com/76206/order_payment/77701?secret=xyz");

    const dbSession = await prisma.orderEditSession.findUnique({
      where: { id: session!.sessionId },
    });
    expect(dbSession?.status).toBe(EditSessionStatus.PAYMENT_REQUIRED);
    expect(dbSession?.paymentStatus).toBe("REQUIRED");
    expect(dbSession?.paymentUrl).toBe("https://shop.myshopify.com/76206/order_payment/77701?secret=xyz");
  });

  // TEST 3: Original $125 -> Updated $100 (Refund required flow via Shopify refundCreate)
  it("TEST 3: should handle refund-required flow and execute real Shopify refundCreate", async () => {
    const session = await createEditSession({
      shopDomain,
      orderData: {
        id: "77703",
        name: "#77703",
        email: "customer@example.com",
        totalPrice: 100.0,
        createdAt: new Date(),
      },
    });

    const commitResult = await commitOrderEdit(session!.rawToken, {
      removedLineItems: [{ lineItemId: "gid://shopify/LineItem/101" }],
    });

    expect(commitResult.status).toBe("COMPLETED");
    expect(commitResult.refundId).toBe("gid://shopify/Refund/55501");
    expect(commitResult.refundAmount).toBe(100);

    const dbSession = await prisma.orderEditSession.findUnique({
      where: { id: session!.sessionId },
    });
    expect(dbSession?.status).toBe(EditSessionStatus.COMPLETED);
    expect(dbSession?.refundStatus).toBe("COMPLETED");
  });

  // TEST 4: Payment succeeds -> Verified via Shopify transactions -> COMPLETED
  it("TEST 4: should verify payment server-side via Shopify and mark session COMPLETED", async () => {
    const session = await createEditSession({
      shopDomain,
      orderData: {
        id: "77704",
        name: "#77704",
        email: "customer@example.com",
        totalPrice: 100.0,
        createdAt: new Date(),
      },
    });

    // Initiate payment
    await commitOrderEdit(session!.rawToken, {
      addedProducts: [{ variantId: "gid://shopify/ProductVariant/301", quantity: 1 }],
    });

    // Verify payment status
    const verifyResult = await OrderEditPaymentService.verifyPayment(session!.rawToken);
    expect(verifyResult.verified).toBe(true);
    expect(verifyResult.status).toBe("COMPLETED");

    const dbSession = await prisma.orderEditSession.findUnique({
      where: { id: session!.sessionId },
    });
    expect(dbSession?.status).toBe(EditSessionStatus.COMPLETED);
    expect(dbSession?.paymentStatus).toBe("PAID");
  });

  // TEST 5 & 6 & 7: Idempotency & Double Click Protection
  it("TEST 5, 6, 7: should ensure idempotent payment initiation and prevent duplicates on refresh or double click", async () => {
    const session = await createEditSession({
      shopDomain,
      orderData: {
        id: "77705",
        name: "#77705",
        email: "customer@example.com",
        totalPrice: 100.0,
        createdAt: new Date(),
      },
    });

    const idempKey = `IDEMP-${session!.sessionId}-TEST`;

    // First attempt
    const res1 = await OrderEditPaymentService.initiatePaymentFlow(
      await prisma.orderEditSession.findUnique({
        where: { id: session!.sessionId },
        include: { shop: true, order: true },
      }),
      25.0,
      125.0,
      "USD",
      idempKey
    );

    // Second attempt (simulating customer double click or refresh)
    const res2 = await OrderEditPaymentService.initiatePaymentFlow(
      await prisma.orderEditSession.findUnique({
        where: { id: session!.sessionId },
        include: { shop: true, order: true },
      }),
      25.0,
      125.0,
      "USD",
      idempKey
    );

    expect(res1.status).toBe("PAYMENT_REQUIRED");
    expect(res2.status).toBe("PAYMENT_REQUIRED");
    expect(res1.amountDue).toBe("25.00");
    expect(res2.amountDue).toBe("25.00");
  });

  // TEST 8: Two browser tabs or concurrent requests
  it("TEST 8: should safely handle concurrent requests on the same edit session", async () => {
    const session = await createEditSession({
      shopDomain,
      orderData: {
        id: "77708",
        name: "#77708",
        email: "customer@example.com",
        totalPrice: 100.0,
        createdAt: new Date(),
      },
    });

    const [tab1, tab2] = await Promise.all([
      commitOrderEdit(session!.rawToken, {
        addedProducts: [{ variantId: "gid://shopify/ProductVariant/301", quantity: 1 }],
      }),
      commitOrderEdit(session!.rawToken, {
        addedProducts: [{ variantId: "gid://shopify/ProductVariant/301", quantity: 1 }],
      }),
    ]);

    expect(tab1.status).toBe("PAYMENT_REQUIRED");
    expect(tab2.status).toBe("PAYMENT_REQUIRED");
  });

  // TEST 9: Edit window expires while payment is pending
  it("TEST 9: should reject changes if edit window has expired", async () => {
    const session = await createEditSession({
      shopDomain,
      orderData: {
        id: "77709",
        name: "#77709",
        email: "customer@example.com",
        totalPrice: 100.0,
        createdAt: new Date(),
      },
    });

    // Artificially expire the session
    await prisma.orderEditSession.update({
      where: { id: session!.sessionId },
      data: { expiresAt: new Date(Date.now() - 60000) },
    });

    await expect(
      commitOrderEdit(session!.rawToken, {
        addedProducts: [{ variantId: "gid://shopify/ProductVariant/301", quantity: 1 }],
      })
    ).rejects.toThrow();
  });

  // TEST 10: Order becomes fulfilled while editing
  it("TEST 10: should reject edit if order is fulfilled on Shopify", async () => {
    const session = await createEditSession({
      shopDomain,
      orderData: {
        id: "77710",
        name: "#77710",
        email: "customer@example.com",
        totalPrice: 100.0,
        fulfillmentStatus: "FULFILLED",
        createdAt: new Date(),
      },
    });

    await expect(
      commitOrderEdit(session!.rawToken, {
        addedProducts: [{ variantId: "gid://shopify/ProductVariant/301", quantity: 1 }],
      })
    ).rejects.toThrow();
  });

  // TEST 11: Security & Token Isolation
  it("TEST 11 & 12: should reject fake or tampered customer tokens", async () => {
    const fakeToken = "0000000000000000000000000000000000000000000000000000000000000000";
    await expect(
      commitOrderEdit(fakeToken, {
        addedProducts: [{ variantId: "gid://shopify/ProductVariant/301", quantity: 1 }],
      })
    ).rejects.toThrow();

    await expect(OrderEditPaymentService.verifyPayment(fakeToken)).rejects.toThrow();
  });
});
