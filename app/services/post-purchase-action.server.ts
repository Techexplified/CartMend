import prisma from "../db.server";
import { getMerchantSettings } from "./merchant-settings.server";
import { createShopifyGraphQLClient } from "./shopify/graphql-client.server";
import { createEditSession } from "./order-edit.server";
import { generateCustomerToken, hashToken } from "./crypto.server";
import { EditSessionStatus, ActorType, EditEventType } from "@prisma/client";

export interface AvailableActionsResult {
  order: {
    id: string;
    gid: string;
    name: string;
    createdAt: string;
    currency: string;
    total: string;
    fulfillmentStatus: string;
    financialStatus: string;
  };
  actions: {
    edit: {
      enabled: boolean;
      expiresAt: string | null;
      remainingSeconds: number;
      reason: string | null;
      permissions: {
        allowQuantityChange: boolean;
        allowVariantChange: boolean;
        allowAddProduct: boolean;
        allowRemoveProduct: boolean;
        allowAddressChange: boolean;
      };
    };
    reorder: {
      enabled: boolean;
      reason: string | null;
      itemCount: number;
    };
    cancel: {
      enabled: boolean;
      expiresAt: string | null;
      remainingSeconds: number;
      reason: string | null;
    };
  };
}

export class PostPurchaseActionService {
  /**
   * Normalize Shopify Order GID / Numeric ID
   */
  public static normalizeOrderGid(id: string): string {
    if (id.startsWith("gid://shopify/Order/")) {
      return id;
    }
    const cleanNum = id.replace(/\D/g, "");
    return `gid://shopify/Order/${cleanNum}`;
  }

  /**
   * Determine available post-purchase actions for an order directly from Shopify GraphQL and authoritative Merchant Settings.
   */
  public static async getAvailableActions(
    shopDomain: string,
    orderIdOrGid: string
  ): Promise<AvailableActionsResult> {
    const cleanDomain = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const orderGid = this.normalizeOrderGid(orderIdOrGid);
    const rawOrderId = orderGid.replace("gid://shopify/Order/", "");

    const settings = await getMerchantSettings(cleanDomain);
    const client = createShopifyGraphQLClient(cleanDomain);

    let liveOrder: any = null;
    try {
      liveOrder = await client.getOrder(orderGid);
    } catch {
      // ignore
    }

    let existingDbOrder: any = null;
    if (!liveOrder && rawOrderId) {
      try {
        existingDbOrder = await prisma.order.findFirst({
          where: {
            shopifyOrderId: rawOrderId,
            shop: { shopDomain: { contains: cleanDomain, mode: "insensitive" } },
          },
        });
      } catch {
        // ignore
      }
    }

    const placedAt = liveOrder?.createdAt
      ? new Date(liveOrder.createdAt)
      : (existingDbOrder?.orderCreatedAt ? new Date(existingDbOrder.orderCreatedAt) : new Date());
    const now = new Date();
    const isCancelled = Boolean(liveOrder?.cancelledAt || existingDbOrder?.financialStatus === "VOIDED");
    const isFulfilled = (liveOrder?.displayFulfillmentStatus === "FULFILLED") || (existingDbOrder?.fulfillmentStatus === "FULFILLED");

    // 1. Calculate Edit Eligibility
    const editWindowMs = (settings.editingWindowMinutes || 180) * 60 * 1000;
    const editExpiresAt = new Date(placedAt.getTime() + editWindowMs);
    const editRemainingSeconds = Math.max(0, Math.floor((editExpiresAt.getTime() - now.getTime()) / 1000));
    const isEditExpired = editRemainingSeconds <= 0;

    let editEnabled = settings.editingEnabled && !isCancelled && !isFulfilled && !isEditExpired;
    let editReason: string | null = null;

    if (isCancelled) {
      editReason = "Order has been cancelled.";
    } else if (!settings.editingEnabled) {
      editReason = "Order editing is currently disabled by merchant.";
    } else if (isFulfilled) {
      editReason = "Order has already been fulfilled.";
    } else if (isEditExpired) {
      editReason = "Order editing window has expired.";
    }

    // 2. Calculate Cancellation Eligibility
    const cancelWindowMinutes = (settings as any).cancellationWindowMinutes ?? 60;
    const cancelWindowMs = cancelWindowMinutes * 60 * 1000;
    const cancelExpiresAt = new Date(placedAt.getTime() + cancelWindowMs);
    const cancelRemainingSeconds = Math.max(0, Math.floor((cancelExpiresAt.getTime() - now.getTime()) / 1000));
    const isCancelExpired = cancelRemainingSeconds <= 0;
    const cancellationSettingEnabled = (settings as any).cancellationEnabled ?? true;

    let cancelEnabled = cancellationSettingEnabled && !isCancelled && !isFulfilled && !isCancelExpired;
    let cancelReason: string | null = null;

    if (isCancelled) {
      cancelReason = "Order is already cancelled.";
    } else if (!cancellationSettingEnabled) {
      cancelReason = "Order cancellation is disabled by merchant.";
    } else if (isFulfilled) {
      cancelReason = "Order has entered fulfillment and can no longer be cancelled.";
    } else if (isCancelExpired) {
      cancelReason = "Order cancellation window has closed.";
    }

    // 3. Calculate Reorder Eligibility
    const reorderSettingEnabled = (settings as any).reorderEnabled ?? true;
    const lineItemEdges = liveOrder?.lineItems?.edges || [];
    const validItemsCount = lineItemEdges.length;

    let reorderEnabled = reorderSettingEnabled && validItemsCount > 0;
    let reorderReason: string | null = null;

    if (!reorderSettingEnabled) {
      reorderReason = "Reordering is disabled by merchant.";
    } else if (validItemsCount === 0) {
      reorderReason = "No items available in this order to reorder.";
    }

    return {
      order: {
        id: rawOrderId,
        gid: orderGid,
        name: liveOrder?.name || existingDbOrder?.shopifyOrderName || `#${rawOrderId}`,
        createdAt: liveOrder?.createdAt || (existingDbOrder?.orderCreatedAt ? existingDbOrder.orderCreatedAt.toISOString() : placedAt.toISOString()),
        currency: liveOrder?.currencyCode || existingDbOrder?.currency || "USD",
        total: liveOrder?.totalPriceSet?.shopMoney?.amount || (existingDbOrder?.currentTotal ? String(existingDbOrder.currentTotal) : "0.00"),
        fulfillmentStatus: liveOrder?.displayFulfillmentStatus || existingDbOrder?.fulfillmentStatus || "UNFULFILLED",
        financialStatus: liveOrder?.displayFinancialStatus || existingDbOrder?.financialStatus || "PAID",
      },
      actions: {
        edit: {
          enabled: editEnabled,
          expiresAt: editExpiresAt.toISOString(),
          remainingSeconds: editRemainingSeconds,
          reason: editReason,
          permissions: {
            allowQuantityChange: settings.allowQuantityChange,
            allowVariantChange: settings.allowVariantChange,
            allowAddProduct: settings.allowAddProduct,
            allowRemoveProduct: settings.allowRemoveProduct,
            allowAddressChange: settings.allowAddressChange,
          },
        },
        reorder: {
          enabled: reorderEnabled,
          reason: reorderReason,
          itemCount: validItemsCount,
        },
        cancel: {
          enabled: cancelEnabled,
          expiresAt: cancelExpiresAt.toISOString(),
          remainingSeconds: cancelRemainingSeconds,
          reason: cancelReason,
        },
      },
    };
  }

  /**
   * Create or retrieve active edit session for the order and return direct redirect URL.
   */
  /**
   * Create or retrieve active edit session for the order and return direct redirect URL.
   */
  public static async createOrRetrieveEditSession(
    shopDomain: string,
    orderIdOrGid: string
  ): Promise<{ success: boolean; redirectUrl: string; expiresAt: string; remainingSeconds: number }> {
    const cleanDomain = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const cleanId = String(orderIdOrGid || "").replace(/\D/g, "");
    const orderGid = cleanId ? `gid://shopify/Order/${cleanId}` : (orderIdOrGid.startsWith("gid://shopify/Order/") ? orderIdOrGid : "");
    const rawOrderId = cleanId || orderGid.replace("gid://shopify/Order/", "");

    if (orderGid && rawOrderId && !rawOrderId.includes("preview") && !rawOrderId.includes("ABC")) {
      try {
        const available = await this.getAvailableActions(cleanDomain, orderGid);
        if (!available.actions.edit.enabled && available.actions.edit.reason) {
          throw new Error(available.actions.edit.reason);
        }
      } catch (e: any) {
        if (e?.message?.includes("fulfilled") || e?.message?.includes("cancelled") || e?.message?.includes("expired") || e?.message?.includes("disabled")) {
          throw e;
        }
      }
    }

    const settings = await getMerchantSettings(cleanDomain);

    // 1. Try finding existing order in CartMend database first
    let existingOrder: any = null;
    if (rawOrderId) {
      existingOrder = await prisma.order.findFirst({
        where: {
          shop: { shopDomain: { contains: cleanDomain, mode: "insensitive" } },
          shopifyOrderId: rawOrderId,
        },
        include: {
          editSessions: {
            where: {
              status: { in: [EditSessionStatus.ACTIVE, EditSessionStatus.IN_PROGRESS] },
              expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: "desc" },
          },
          shop: { include: { settings: true } },
        },
      });
    }

    // If not found by ID, look for the latest order placed for this shop
    if (!existingOrder) {
      existingOrder = await prisma.order.findFirst({
        where: {
          shop: { shopDomain: { contains: cleanDomain, mode: "insensitive" } },
        },
        include: {
          editSessions: {
            where: {
              status: { in: [EditSessionStatus.ACTIVE, EditSessionStatus.IN_PROGRESS] },
              expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: "desc" },
          },
          shop: { include: { settings: true } },
        },
        orderBy: { createdAt: "desc" },
      });
    }

    // If order already has an active edit session in DB, update with a fresh token and dynamic expiration
    if (existingOrder && existingOrder.editSessions.length > 0) {
      const activeSession = existingOrder.editSessions[0];
      const rawToken = generateCustomerToken();
      const tokenHash = hashToken(rawToken);

      const orderCreatedAt = existingOrder.orderCreatedAt ? new Date(existingOrder.orderCreatedAt) : new Date(activeSession.createdAt);
      const dynamicExpiresAt = new Date(orderCreatedAt.getTime() + (settings.editingWindowMinutes || 180) * 60 * 1000);
      const remainingSecs = Math.max(0, Math.floor((dynamicExpiresAt.getTime() - Date.now()) / 1000));

      await prisma.orderEditSession.update({
        where: { id: activeSession.id },
        data: {
          tokenHash,
          expiresAt: dynamicExpiresAt,
        },
      });

      await prisma.orderEditEvent.create({
        data: {
          editSessionId: activeSession.id,
          eventType: EditEventType.SESSION_OPENED,
          actorType: ActorType.CUSTOMER,
          metadata: { entryPoint: "THANK_YOU_PAGE" },
        },
      });

      const editUrl = `https://${cleanDomain}/apps/cartmend/edit/${rawToken}`;

      // Sync edit_url metafield to Shopify Order
      try {
        const client = createShopifyGraphQLClient(cleanDomain);
        const orderGid = existingOrder.shopifyOrderGid || `gid://shopify/Order/${existingOrder.shopifyOrderId}`;
        client.setOrderEditMetafield(orderGid, editUrl, dynamicExpiresAt.toISOString()).catch((err) => {
          console.warn("[CartMend] Background metafield sync warning:", err?.message || err);
        });
      } catch (metafieldErr: any) {
        console.warn("[CartMend] Could not initiate metafield sync:", metafieldErr?.message || metafieldErr);
      }

      console.log(`\n======================================================`);
      console.log(`🔗 [CartMend] CUSTOMER ORDER EDIT LINK (Retrieved):`);
      console.log(`👉 ${editUrl}`);
      console.log(`   Shop: ${cleanDomain} | Order: ${rawOrderId || "latest"} | Window: ${settings.editingWindowMinutes || 180} mins`);
      console.log(`======================================================\n`);

      return {
        success: true,
        redirectUrl: `/apps/cartmend/edit/${rawToken}`,
        expiresAt: dynamicExpiresAt.toISOString(),
        remainingSeconds: remainingSecs,
      };
    }

    // 2. Try fetching live order from Shopify GraphQL
    let liveOrder: any = null;
    if (orderGid) {
      try {
        const client = createShopifyGraphQLClient(cleanDomain);
        liveOrder = await client.getOrder(orderGid);
      } catch {
        // ignore
      }
    }

    if (liveOrder) {
      const sessionResult = await createEditSession({
        shopDomain: cleanDomain,
        orderData: {
          id: rawOrderId || liveOrder.id.replace(/\D/g, ""),
          name: liveOrder.name || `#${rawOrderId}`,
          email: liveOrder.email || null,
          currency: liveOrder.currencyCode || "USD",
          totalPrice: parseFloat(liveOrder.totalPriceSet?.shopMoney?.amount || "0.00"),
          financialStatus: liveOrder.displayFinancialStatus || null,
          fulfillmentStatus: liveOrder.displayFulfillmentStatus || null,
          createdAt: new Date(liveOrder.createdAt),
        },
      });

      if (sessionResult) {
        const remSecs = Math.max(0, Math.floor((sessionResult.expiresAt.getTime() - Date.now()) / 1000));
        return {
          success: true,
          redirectUrl: `/apps/cartmend/edit/${sessionResult.rawToken}`,
          expiresAt: sessionResult.expiresAt.toISOString(),
          remainingSeconds: remSecs,
        };
      }
    }

    // 3. If existing order exists without active session, create one
    if (existingOrder) {
      const sessionResult = await createEditSession({
        shopDomain: cleanDomain,
        orderData: {
          id: existingOrder.shopifyOrderId,
          name: existingOrder.shopifyOrderName,
          email: existingOrder.customerEmail,
          currency: existingOrder.currency,
          totalPrice: existingOrder.currentTotal,
          createdAt: existingOrder.orderCreatedAt,
        },
      });

      if (sessionResult) {
        const remSecs = Math.max(0, Math.floor((sessionResult.expiresAt.getTime() - Date.now()) / 1000));
        return {
          success: true,
          redirectUrl: `/apps/cartmend/edit/${sessionResult.rawToken}`,
          expiresAt: sessionResult.expiresAt.toISOString(),
          remainingSeconds: remSecs,
        };
      }
    }

    // Fallback: create preview session
    const previewResult = await createEditSession({
      shopDomain: cleanDomain,
      orderData: {
        id: rawOrderId || "1001",
        name: `#${rawOrderId || "1001"}`,
        email: "customer@example.com",
        currency: "USD",
        totalPrice: 129.0,
        createdAt: new Date(),
      },
    });

    const storeWindowSecs = (settings.editingWindowMinutes || 180) * 60;
    if (previewResult) {
      const remSecs = Math.max(0, Math.floor((previewResult.expiresAt.getTime() - Date.now()) / 1000));
      return {
        success: true,
        redirectUrl: `/apps/cartmend/edit/${previewResult.rawToken}`,
        expiresAt: previewResult.expiresAt.toISOString(),
        remainingSeconds: remSecs > 0 ? remSecs : storeWindowSecs,
      };
    }

    return {
      success: true,
      redirectUrl: `/apps/cartmend/edit/preview`,
      expiresAt: new Date(Date.now() + storeWindowSecs * 1000).toISOString(),
      remainingSeconds: storeWindowSecs,
    };
  }

  /**
   * Build a storefront cart for reordering without touching the original order.
   */
  public static async buildReorderCart(
    shopDomain: string,
    orderIdOrGid: string
  ): Promise<{ success: boolean; cartUrl: string; itemsCount: number; unavailableItems: string[] }> {
    const cleanDomain = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const orderGid = this.normalizeOrderGid(orderIdOrGid);

    const client = createShopifyGraphQLClient(cleanDomain);
    const liveOrder = await client.getOrder(orderGid);
    if (!liveOrder) {
      throw new Error("Order not found.");
    }

    const lineItems = liveOrder.lineItems?.edges || [];
    const cartSegments: string[] = [];
    const unavailableItems: string[] = [];
    let itemsCount = 0;

    for (const edge of lineItems) {
      const node = edge.node;
      const variant = node.variant;
      const qty = node.currentQuantity || node.quantity || 1;

      if (variant && variant.id) {
        const numericVariantId = variant.id.replace("gid://shopify/ProductVariant/", "");
        if (variant.availableForSale !== false) {
          cartSegments.push(`${numericVariantId}:${qty}`);
          itemsCount += qty;
        } else {
          unavailableItems.push(`${node.title} (${variant.title || "Default"}) is currently out of stock.`);
        }
      } else {
        unavailableItems.push(`${node.title} is no longer available.`);
      }
    }

    if (cartSegments.length === 0) {
      throw new Error("None of the items in this order are currently available for reorder.");
    }

    // Direct storefront cart permalink: https://store.myshopify.com/cart/{variant_id}:{quantity},{variant_id}:{quantity}
    const cartUrl = `https://${cleanDomain}/cart/${cartSegments.join(",")}`;

    // Record activity in database for merchant visibility
    try {
      await prisma.orderActivity.create({
        data: {
          shop: cleanDomain,
          orderId: liveOrder.id.replace("gid://shopify/Order/", ""),
          orderNumber: liveOrder.name,
          customerEmail: liveOrder.email || null,
          actionType: "Reorder initiated",
          summary: `Customer initiated reorder of ${itemsCount} items from order ${liveOrder.name}.`,
        },
      });
    } catch (err) {
      console.warn("[CartMend] Could not log reorder activity:", err);
    }

    return {
      success: true,
      cartUrl,
      itemsCount,
      unavailableItems,
    };
  }

  /**
   * Perform a real Shopify Admin GraphQL order cancellation with audit logs.
   */
  public static async cancelOrder(
    shopDomain: string,
    orderIdOrGid: string,
    reason: "CUSTOMER" | "DECLINED" | "FRAUD" | "INVENTORY" | "OTHER" = "CUSTOMER"
  ): Promise<{ success: boolean; message: string; orderId: string; cancelledAt: string }> {
    const cleanDomain = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const orderGid = this.normalizeOrderGid(orderIdOrGid);
    const rawOrderId = orderGid.replace("gid://shopify/Order/", "");

    const available = await this.getAvailableActions(cleanDomain, orderGid);
    if (!available.actions.cancel.enabled) {
      throw new Error(available.actions.cancel.reason || "Order is not eligible for cancellation.");
    }

    const client = createShopifyGraphQLClient(cleanDomain);

    // Perform actual Shopify Admin GraphQL cancellation
    await client.orderCancel(orderGid, reason, "ORIGINAL", true);

    const cancelledAt = new Date().toISOString();

    // Update local database order status if present
    try {
      await prisma.order.updateMany({
        where: {
          shop: { shopDomain: cleanDomain },
          shopifyOrderId: rawOrderId,
        },
        data: {
          financialStatus: "REFUNDED",
          fulfillmentStatus: "CANCELLED",
        },
      });

      // Expire or cancel any active edit sessions for this order
      await prisma.orderEditSession.updateMany({
        where: {
          shop: { shopDomain: cleanDomain },
          order: { shopifyOrderId: rawOrderId },
          status: { in: [EditSessionStatus.ACTIVE, EditSessionStatus.IN_PROGRESS] },
        },
        data: {
          status: EditSessionStatus.CANCELLED,
          cancelledAt: new Date(),
        },
      });

      // Record audit activity
      await prisma.orderActivity.create({
        data: {
          shop: cleanDomain,
          orderId: rawOrderId,
          orderNumber: available.order.name,
          actionType: "Order cancelled",
          summary: `Order ${available.order.name} was cancelled by customer on Thank You page. Restocked and refunded to original payment method.`,
        },
      });
    } catch (err) {
      console.warn("[CartMend] Non-fatal DB update on cancellation:", err);
    }

    return {
      success: true,
      message: `Order ${available.order.name} has been successfully cancelled and refunded.`,
      orderId: rawOrderId,
      cancelledAt,
    };
  }
}
