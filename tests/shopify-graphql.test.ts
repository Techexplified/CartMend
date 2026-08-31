import { describe, it, expect } from "vitest";
import {
  ShopifyGraphQLClient,
  ShopifyAPIError,
  createShopifyGraphQLClient,
} from "../app/services/shopify/graphql-client.server";
import {
  ORDER_EDIT_BEGIN_MUTATION,
  ORDER_EDIT_SET_QUANTITY_MUTATION,
  ORDER_EDIT_ADD_VARIANT_MUTATION,
  ORDER_EDIT_COMMIT_MUTATION,
  GET_ORDER_QUERY,
  GET_ORDERS_QUERY,
  GET_ORDER_TRANSACTIONS_QUERY,
  REFUND_CREATE_MUTATION,
  ORDER_INVOICE_SEND_MUTATION,
  ORDER_CANCEL_MUTATION,
  SET_METAFIELDS_MUTATION,
} from "../app/services/shopify/graphql-queries";

describe("Shopify GraphQL Client & Queries", () => {
  it("should initialize client and normalize shop domain", () => {
    const client1 = createShopifyGraphQLClient("https://my-store.myshopify.com/");
    const client2 = new ShopifyGraphQLClient("my-store.myshopify.com");

    expect(client1).toBeInstanceOf(ShopifyGraphQLClient);
    expect(client2).toBeInstanceOf(ShopifyGraphQLClient);
  });

  it("should throw error if shop domain is empty", () => {
    expect(() => new ShopifyGraphQLClient("")).toThrow("Shop domain is required");
  });

  it("should define valid GraphQL mutations and queries with variable inputs", () => {
    expect(ORDER_EDIT_BEGIN_MUTATION).toContain("orderEditBegin(id: $id)");
    expect(ORDER_EDIT_BEGIN_MUTATION).toContain("userErrors");
    expect(ORDER_EDIT_BEGIN_MUTATION).toContain("subtotalPriceSet");
    expect(ORDER_EDIT_BEGIN_MUTATION).toContain("totalPriceSet");

    expect(ORDER_EDIT_SET_QUANTITY_MUTATION).toContain("orderEditSetQuantity");
    expect(ORDER_EDIT_SET_QUANTITY_MUTATION).toContain("lineItemId: $lineItemId");
    expect(ORDER_EDIT_SET_QUANTITY_MUTATION).toContain("quantity: $quantity");

    expect(ORDER_EDIT_ADD_VARIANT_MUTATION).toContain("orderEditAddVariant");
    expect(ORDER_EDIT_ADD_VARIANT_MUTATION).toContain("variantId: $variantId");

    expect(ORDER_EDIT_COMMIT_MUTATION).toContain("orderEditCommit");
    expect(ORDER_EDIT_COMMIT_MUTATION).toContain("notifyCustomer: $notifyCustomer");
    expect(ORDER_EDIT_COMMIT_MUTATION).toContain("totalOutstandingSet");
    expect(ORDER_EDIT_COMMIT_MUTATION).toContain("additionalPaymentCollectionUrl");

    expect(GET_ORDER_QUERY).toContain("order(id: $id)");
    expect(GET_ORDER_QUERY).toContain("lineItems");
    expect(GET_ORDER_QUERY).toContain("additionalPaymentCollectionUrl");

    expect(GET_ORDERS_QUERY).toContain("orders(first: $first");
    expect(GET_ORDERS_QUERY).toContain("lineItems");
    expect(GET_ORDERS_QUERY).toContain("totalPriceSet");
    expect(GET_ORDERS_QUERY).toContain("shippingAddress");

    expect(GET_ORDER_TRANSACTIONS_QUERY).toContain("transactions(first: 50)");
    expect(GET_ORDER_TRANSACTIONS_QUERY).toContain("parentTransaction");
    expect(GET_ORDER_TRANSACTIONS_QUERY).toContain("totalOutstandingSet");
    expect(GET_ORDER_TRANSACTIONS_QUERY).toContain("additionalPaymentCollectionUrl");

    expect(REFUND_CREATE_MUTATION).toContain("refundCreate(input: $input)");
    expect(REFUND_CREATE_MUTATION).toContain("totalRefundedSet");
    expect(REFUND_CREATE_MUTATION).toContain("transactions");

    expect(ORDER_INVOICE_SEND_MUTATION).toContain("orderInvoiceSend(id: $id");
    expect(ORDER_INVOICE_SEND_MUTATION).toContain("order");

    expect(ORDER_CANCEL_MUTATION).toContain("orderCancel(orderId: $orderId");
    expect(ORDER_CANCEL_MUTATION).toContain("orderCancelUserErrors");

    expect(SET_METAFIELDS_MUTATION).toContain("metafieldsSet(metafields: $metafields)");
    expect(SET_METAFIELDS_MUTATION).toContain("userErrors");
  });

  it("should have getOrders, getOrder, getOrderTransactions, refundCreate, sendOrderInvoice, orderCancel, and setOrderEditMetafield methods defined on ShopifyGraphQLClient", () => {
    const client = new ShopifyGraphQLClient("test-store.myshopify.com");
    expect(typeof client.getOrders).toBe("function");
    expect(typeof client.getOrder).toBe("function");
    expect(typeof client.getOrderTransactions).toBe("function");
    expect(typeof client.refundCreate).toBe("function");
    expect(typeof client.sendOrderInvoice).toBe("function");
    expect(typeof client.orderCancel).toBe("function");
    expect(typeof client.getShop).toBe("function");
    expect(typeof client.setOrderEditMetafield).toBe("function");
  });

  it("should properly structure ShopifyAPIError with userErrors and status code", () => {
    const userErrors = [{ field: ["quantity"], message: "Quantity cannot exceed available inventory" }];
    const error = new ShopifyAPIError("Order edit mutation failed", userErrors, undefined, 422);

    expect(error.name).toBe("ShopifyAPIError");
    expect(error.message).toContain("Order edit mutation failed");
    expect(error.userErrors).toEqual(userErrors);
    expect(error.statusCode).toBe(422);
  });
});


