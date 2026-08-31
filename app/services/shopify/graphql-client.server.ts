import { unauthenticated } from "../../shopify.server";
import {
  GET_SHOP_QUERY,
  GET_ORDERS_QUERY,
  GET_ORDER_QUERY,
  GET_ORDER_TRANSACTIONS_QUERY,
  GET_PRODUCT_VARIANTS_QUERY,
  ORDER_EDIT_BEGIN_MUTATION,
  ORDER_EDIT_SET_QUANTITY_MUTATION,
  ORDER_EDIT_ADD_VARIANT_MUTATION,
  ORDER_EDIT_COMMIT_MUTATION,
  REFUND_CREATE_MUTATION,
  ORDER_INVOICE_SEND_MUTATION,
  ORDER_UPDATE_MUTATION,
  ORDER_CANCEL_MUTATION,
  SET_METAFIELDS_MUTATION,
} from "./graphql-queries";

export interface GraphQLUserError {
  field?: string[];
  message: string;
}

export class ShopifyAPIError extends Error {
  public userErrors?: GraphQLUserError[];
  public rawErrors?: any[];
  public statusCode?: number;

  constructor(message: string, userErrors?: GraphQLUserError[], rawErrors?: any[], statusCode?: number) {
    super(message);
    this.name = "ShopifyAPIError";
    this.userErrors = userErrors;
    this.rawErrors = rawErrors;
    this.statusCode = statusCode;
  }
}

export class ShopifyGraphQLClient {
  private shop: string;

  constructor(shop: string) {
    if (!shop) {
      throw new Error("Shop domain is required to initialize ShopifyGraphQLClient");
    }
    this.shop = shop.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  /**
   * Safe execution of GraphQL query/mutation with offline admin context and retries.
   */
  public async execute<T = any>(
    query: string,
    variables?: Record<string, any>,
    retries = 2
  ): Promise<T> {
    let attempt = 0;
    while (attempt <= retries) {
      attempt++;
      try {
        const { admin } = await unauthenticated.admin(this.shop);
        const response = await admin.graphql(query, {
          variables: variables || {},
        });

        if (!response.ok) {
          if (response.status === 429 && attempt <= retries) {
            // Exponential backoff
            await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
            continue;
          }
          const text = await response.text();
          throw new ShopifyAPIError(
            `Shopify Admin API HTTP error (${response.status}): ${text.slice(0, 300)}`,
            undefined,
            undefined,
            response.status
          );
        }

        const json = (await response.json()) as any;

        if (json?.errors && json.errors.length > 0) {
          const errorMsg = json.errors.map((e: any) => e.message).join("; ");
          throw new ShopifyAPIError(`Shopify GraphQL Error: ${errorMsg}`, undefined, json.errors);
        }

        return json?.data as T;
      } catch (err: any) {
        if (attempt <= retries && err?.message?.includes("THROTTLED")) {
          await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
          continue;
        }
        if (err instanceof ShopifyAPIError) {
          throw err;
        }
        throw new ShopifyAPIError(
          `Failed to execute Shopify GraphQL operation for shop ${this.shop}: ${err.message || "Unknown error"}`
        );
      }
    }

    throw new ShopifyAPIError(`Shopify GraphQL request timed out or exceeded retry limit for ${this.shop}`);
  }

  public async getShop() {
    const data = await this.execute<{ shop: any }>(GET_SHOP_QUERY);
    return data?.shop;
  }

  public async getOrders(first = 20, query?: string) {
    const data = await this.execute<{
      orders: {
        pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean };
        edges: Array<{ node: any }>;
      };
    }>(GET_ORDERS_QUERY, { first, query });
    return data?.orders?.edges?.map((edge) => edge.node) || [];
  }

  public async getOrder(shopifyOrderId: string) {
    const gid = shopifyOrderId.startsWith("gid://")
      ? shopifyOrderId
      : `gid://shopify/Order/${shopifyOrderId}`;
    const data = await this.execute<{ order: any }>(GET_ORDER_QUERY, { id: gid });
    return data?.order;
  }

  public async getOrderTransactions(shopifyOrderId: string) {
    const gid = shopifyOrderId.startsWith("gid://")
      ? shopifyOrderId
      : `gid://shopify/Order/${shopifyOrderId}`;
    const data = await this.execute<{ order: any }>(GET_ORDER_TRANSACTIONS_QUERY, { id: gid });
    return data?.order;
  }

  public async getProductVariants(productId: string) {
    const gid = productId.startsWith("gid://")
      ? productId
      : `gid://shopify/Product/${productId}`;
    const data = await this.execute<{ product: any }>(GET_PRODUCT_VARIANTS_QUERY, { id: gid });
    return data?.product;
  }

  public async orderEditBegin(orderGid: string) {
    const data = await this.execute<{
      orderEditBegin: {
        calculatedOrder?: any;
        userErrors?: GraphQLUserError[];
      };
    }>(ORDER_EDIT_BEGIN_MUTATION, { id: orderGid });

    const result = data?.orderEditBegin;
    if (result?.userErrors && result.userErrors.length > 0) {
      throw new ShopifyAPIError(
        `orderEditBegin failed: ${result.userErrors.map((u) => u.message).join(", ")}`,
        result.userErrors
      );
    }
    return result?.calculatedOrder;
  }

  public async orderEditSetQuantity(calculatedOrderId: string, lineItemId: string, quantity: number) {
    const data = await this.execute<{
      orderEditSetQuantity: {
        calculatedOrder?: any;
        calculatedLineItem?: any;
        userErrors?: GraphQLUserError[];
      };
    }>(ORDER_EDIT_SET_QUANTITY_MUTATION, {
      id: calculatedOrderId,
      lineItemId,
      quantity,
    });

    const result = data?.orderEditSetQuantity;
    if (result?.userErrors && result.userErrors.length > 0) {
      throw new ShopifyAPIError(
        `orderEditSetQuantity failed: ${result.userErrors.map((u) => u.message).join(", ")}`,
        result.userErrors
      );
    }
    return result;
  }

  public async orderEditAddVariant(calculatedOrderId: string, variantId: string, quantity: number) {
    const data = await this.execute<{
      orderEditAddVariant: {
        calculatedOrder?: any;
        calculatedLineItem?: any;
        userErrors?: GraphQLUserError[];
      };
    }>(ORDER_EDIT_ADD_VARIANT_MUTATION, {
      id: calculatedOrderId,
      variantId,
      quantity,
    });

    const result = data?.orderEditAddVariant;
    if (result?.userErrors && result.userErrors.length > 0) {
      throw new ShopifyAPIError(
        `orderEditAddVariant failed: ${result.userErrors.map((u) => u.message).join(", ")}`,
        result.userErrors
      );
    }
    return result;
  }

  public async orderEditCommit(calculatedOrderId: string, notifyCustomer = true, staffNote = "Edited via CartMend") {
    const data = await this.execute<{
      orderEditCommit: {
        order?: any;
        userErrors?: GraphQLUserError[];
      };
    }>(ORDER_EDIT_COMMIT_MUTATION, {
      id: calculatedOrderId,
      notifyCustomer,
      staffNote,
    });

    const result = data?.orderEditCommit;
    if (result?.userErrors && result.userErrors.length > 0) {
      throw new ShopifyAPIError(
        `orderEditCommit failed: ${result.userErrors.map((u) => u.message).join(", ")}`,
        result.userErrors
      );
    }
    return result?.order;
  }

  public async refundCreate(input: Record<string, any>) {
    const data = await this.execute<{
      refundCreate: {
        refund?: any;
        userErrors?: GraphQLUserError[];
      };
    }>(REFUND_CREATE_MUTATION, { input });

    const result = data?.refundCreate;
    if (result?.userErrors && result.userErrors.length > 0) {
      throw new ShopifyAPIError(
        `refundCreate failed: ${result.userErrors.map((u) => u.message).join(", ")}`,
        result.userErrors
      );
    }
    return result?.refund;
  }

  public async sendOrderInvoice(orderGid: string, email?: Record<string, any>) {
    const data = await this.execute<{
      orderInvoiceSend: {
        order?: any;
        userErrors?: GraphQLUserError[];
      };
    }>(ORDER_INVOICE_SEND_MUTATION, { id: orderGid, email });

    const result = data?.orderInvoiceSend;
    if (result?.userErrors && result.userErrors.length > 0) {
      throw new ShopifyAPIError(
        `orderInvoiceSend failed: ${result.userErrors.map((u) => u.message).join(", ")}`,
        result.userErrors
      );
    }
    return result?.order;
  }

  public async updateOrderShippingAddress(orderGid: string, shippingAddress: Record<string, any>) {
    const data = await this.execute<{
      orderUpdate: {
        order?: any;
        userErrors?: GraphQLUserError[];
      };
    }>(ORDER_UPDATE_MUTATION, {
      input: {
        id: orderGid,
        shippingAddress,
      },
    });

    const result = data?.orderUpdate;
    if (result?.userErrors && result.userErrors.length > 0) {
      throw new ShopifyAPIError(
        `orderUpdate shipping address failed: ${result.userErrors.map((u) => u.message).join(", ")}`,
        result.userErrors
      );
    }
    return result?.order;
  }

  public async orderCancel(
    orderGid: string,
    reason: "CUSTOMER" | "DECLINED" | "FRAUD" | "INVENTORY" | "OTHER" = "CUSTOMER",
    restock = true,
    notifyCustomer = false,
    staffNote = "Order cancelled by customer via CartMend"
  ) {
    const data = await this.execute<{
      orderCancel: {
        job?: { id: string; done: boolean };
        orderCancelUserErrors?: GraphQLUserError[];
      };
    }>(ORDER_CANCEL_MUTATION, {
      orderId: orderGid,
      reason,
      restock,
      notifyCustomer,
      staffNote,
    });

    const result = data?.orderCancel;
    if (result?.orderCancelUserErrors && result.orderCancelUserErrors.length > 0) {
      throw new ShopifyAPIError(
        `orderCancel failed: ${result.orderCancelUserErrors.map((u) => u.message).join(", ")}`,
        result.orderCancelUserErrors
      );
    }
    return result;
  }

  public async setOrderEditMetafield(orderGid: string, editUrl: string, expiresAt?: string) {
    const metafields: any[] = [
      {
        ownerId: orderGid,
        namespace: "cartmend",
        key: "edit_url",
        value: editUrl,
        type: "url",
      },
    ];

    if (expiresAt) {
      metafields.push({
        ownerId: orderGid,
        namespace: "cartmend",
        key: "expires_at",
        value: expiresAt,
        type: "date_time",
      });
    }

    try {
      const data = await this.execute<{
        metafieldsSet: {
          metafields?: any[];
          userErrors?: GraphQLUserError[];
        };
      }>(SET_METAFIELDS_MUTATION, { metafields });

      const result = data?.metafieldsSet;
      if (result?.userErrors && result.userErrors.length > 0) {
        console.warn(`[CartMend] Warning setting order metafields:`, result.userErrors);
      }
      return result?.metafields;
    } catch (err: any) {
      console.warn(`[CartMend] Non-blocking error setting order metafields:`, err?.message || err);
      return null;
    }
  }
}

export function createShopifyGraphQLClient(shop: string): ShopifyGraphQLClient {
  return new ShopifyGraphQLClient(shop);
}
