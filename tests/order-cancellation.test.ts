import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import prisma from "../app/db.server";
import {
  createEditSession,
  commitOrderEdit,
  previewOrderEdit,
} from "../app/services/order-edit.server";
import { updateMerchantSettings, getOrCreateShop } from "../app/services/merchant-settings.server";
import { MerchantPermissionDenied } from "../app/services/errors";
import { EditSessionStatus } from "@prisma/client";

const mockOrderCancel = vi.fn().mockResolvedValue({
  orderCancelUserErrors: [],
  job: { id: "job_cancel_1", done: true },
});

vi.mock("../app/services/shopify/graphql-client.server", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    createShopifyGraphQLClient: vi.fn((shop: string) => {
      return {
        getOrder: vi.fn().mockResolvedValue({
          id: "gid://shopify/Order/77799",
          name: "#77799",
          currencyCode: "USD",
          totalPriceSet: { shopMoney: { amount: "79.00", currencyCode: "USD" } },
          subtotalPriceSet: { shopMoney: { amount: "79.00", currencyCode: "USD" } },
          lineItems: {
            edges: [
              {
                node: {
                  id: "gid://shopify/LineItem/item_1",
                  title: "shirt",
                  quantity: 1,
                  originalUnitPriceSet: { shopMoney: { amount: "79.00", currencyCode: "USD" } },
                },
              },
            ],
          },
        }),
        orderCancel: mockOrderCancel,
        getOrderTransactions: vi.fn().mockResolvedValue({
          id: "gid://shopify/Order/77799",
          transactions: [
            {
              id: "gid://shopify/OrderTransaction/tx_1",
              kind: "CAPTURE",
              status: "SUCCESS",
              gateway: "shopify_payments",
              amountSet: { shopMoney: { amount: "79.00", currencyCode: "USD" } },
            },
          ],
        }),
        refundCreate: vi.fn().mockResolvedValue({
          id: "gid://shopify/Refund/ref_cancel_79",
          totalRefundedSet: { shopMoney: { amount: "79.00", currencyCode: "USD" } },
        }),
        setOrderEditMetafield: vi.fn().mockResolvedValue([]),
      };
    }),
  };
});

describe("Order Cancellation & Refund Tests", () => {
  const testShop = `cancel-test-${Date.now()}.myshopify.com`;

  beforeEach(async () => {
    mockOrderCancel.mockClear();
    await getOrCreateShop(testShop);
    await updateMerchantSettings(testShop, {
      editingEnabled: true,
      editingWindowMinutes: 60,
      allowOrderCancellation: true,
      allowRemoveProduct: true,
      allowRefundForDifference: true,
      requirePaymentForDifference: true,
    });
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain: testShop } }).catch(() => {});
  });

  it("should preview order cancellation with $0.00 total and full refund difference", async () => {
    const sessionRes = await createEditSession({
      shopDomain: testShop,
      orderData: {
        id: "77799",
        name: "#77799",
        email: "customer@example.com",
        currency: "USD",
        totalPrice: "79.00",
        createdAt: new Date(),
      },
    });
    expect(sessionRes).not.toBeNull();

    const preview = await previewOrderEdit(sessionRes!.rawToken, {
      isCancellation: true,
    });

    expect(preview.originalTotal).toBe(79.0);
    expect(preview.calculatedTotal).toBe(0.0);
    expect(preview.difference).toBe(-79.0);
    expect(preview.refundExpected).toBe(true);
    expect(preview.paymentRequired).toBe(false);
  });

  it("should preview order cancellation for preview token", async () => {
    const preview = await previewOrderEdit("preview", {
      isCancellation: true,
    });

    expect(preview.calculatedTotal).toBe(0.0);
    expect(preview.difference).toBe(-129.0);
    expect(preview.refundExpected).toBe(true);
  });

  it("should commit order cancellation, deduct price to 0, and issue full refund via Shopify", async () => {
    const sessionRes = await createEditSession({
      shopDomain: testShop,
      orderData: {
        id: "77799",
        name: "#77799",
        email: "customer@example.com",
        currency: "USD",
        totalPrice: "79.00",
        createdAt: new Date(),
      },
    });

    const commitResult = await commitOrderEdit(sessionRes!.rawToken, {
      isCancellation: true,
      cancelReason: "CUSTOMER",
    });

    expect(commitResult.success).toBe(true);
    expect(commitResult.status).toBe("COMPLETED");
    expect(commitResult.total).toBe(0.0);
    expect(commitResult.difference).toBe(-79.0);
    expect(commitResult.refundAmount).toBe(79.0);
    expect(mockOrderCancel).toHaveBeenCalledWith(
      "gid://shopify/Order/77799",
      "CUSTOMER",
      true,
      true,
      "Order cancelled by customer via CartMend"
    );

    // Verify Database state
    const dbOrder = await prisma.order.findFirst({
      where: { shopifyOrderId: "77799" },
    });
    expect(dbOrder?.currentTotal).toBe(0.0);
    expect(dbOrder?.fulfillmentStatus).toBe("CANCELLED");
    expect(dbOrder?.financialStatus).toBe("REFUNDED");

    const dbSession = await prisma.orderEditSession.findUnique({
      where: { id: sessionRes!.sessionId },
    });
    expect(dbSession?.status).toBe(EditSessionStatus.COMPLETED);
    expect(dbSession?.finalTotal).toBe(0.0);
    expect(dbSession?.difference).toBe(-79.0);
    expect(dbSession?.refundStatus).toBe("COMPLETED");
  });

  it("should block order cancellation if merchant policy disables cancellation", async () => {
    await updateMerchantSettings(testShop, {
      editingEnabled: true,
      allowOrderCancellation: false,
      allowRemoveProduct: false,
      cancellationEnabled: false,
    });

    const sessionRes = await createEditSession({
      shopDomain: testShop,
      orderData: {
        id: "77799",
        name: "#77799",
        email: "customer@example.com",
        currency: "USD",
        totalPrice: "79.00",
        createdAt: new Date(),
      },
    });

    await expect(
      commitOrderEdit(sessionRes!.rawToken, {
        isCancellation: true,
      })
    ).rejects.toThrow(MerchantPermissionDenied);
  });
});
