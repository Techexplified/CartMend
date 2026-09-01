import prisma from "../db.server";
import { InvalidEditRequest, ShopNotFound } from "./errors";

export interface ShopSettingsUpdateInput {
  editingEnabled?: boolean;
  editingWindowMinutes?: number;
  allowQuantityChange?: boolean;
  allowVariantChange?: boolean;
  allowAddProduct?: boolean;
  allowRemoveProduct?: boolean;
  allowAddressChange?: boolean;
  cancellationEnabled?: boolean;
  cancellationWindowMinutes?: number;
  reorderEnabled?: boolean;
  requirePaymentForDifference?: boolean;
  allowRefundForDifference?: boolean;
  notifyCustomer?: boolean;
  sendEditLinkEmail?: boolean;
  sendPaymentRefundEmails?: boolean;
  theme?: string;
  supportEmail?: string | null;
}

export async function getOrCreateShop(shopDomain: string, shopifyShopId?: string) {
  const rawDomain = (shopDomain || "").trim();
  const cleanDomain = rawDomain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();

  try {
    let shop: any = null;

    if (cleanDomain) {
      shop = await prisma.shop.findUnique({
        where: { shopDomain: cleanDomain },
        include: { settings: true },
      });

      if (!shop) {
        shop = await prisma.shop.findFirst({
          where: { shopDomain: { equals: cleanDomain, mode: "insensitive" } },
          include: { settings: true },
        });
      }
    }

    if (!shop && !cleanDomain) {
      shop = await prisma.shop.findFirst({
        where: { uninstalledAt: null },
        include: { settings: true },
        orderBy: { updatedAt: "desc" },
      });
    }

    if (!shop) {
      shop = await prisma.shop.create({
        data: {
          shopDomain: cleanDomain || "shop.myshopify.com",
          shopifyShopId: shopifyShopId || null,
          settings: {
            create: {
              editingEnabled: false,
              editingWindowMinutes: 180,
              allowQuantityChange: true,
              allowVariantChange: true,
              allowAddProduct: false,
              allowRemoveProduct: true,
              allowAddressChange: true,
              cancellationEnabled: true,
              cancellationWindowMinutes: 60,
              reorderEnabled: true,
              requirePaymentForDifference: true,
              allowRefundForDifference: true,
              notifyCustomer: false,
              sendEditLinkEmail: false,
              sendPaymentRefundEmails: true,
              theme: "Light",
              supportEmail: `support@${cleanDomain || "example.com"}`,
            },
          },
        },
        include: { settings: true },
      });
    }

    if (!shop.settings) {
      const settings = await prisma.shopSettings.upsert({
        where: { shopId: shop.id },
        update: {},
        create: {
          shopId: shop.id,
          editingEnabled: false,
          editingWindowMinutes: 180,
          allowQuantityChange: true,
          allowVariantChange: true,
          allowAddProduct: false,
          allowRemoveProduct: true,
          allowAddressChange: true,
          cancellationEnabled: true,
          cancellationWindowMinutes: 60,
          reorderEnabled: true,
          requirePaymentForDifference: true,
          allowRefundForDifference: true,
          notifyCustomer: false,
          sendEditLinkEmail: false,
          sendPaymentRefundEmails: true,
          theme: "Light",
          supportEmail: `support@${shop.shopDomain}`,
        },
      });
      shop.settings = settings;
    }

    return shop;
  } catch (error: any) {
    if (error?.code === "P2002") {
      const shop = await prisma.shop.findFirst({
        where: {
          OR: [
            { shopDomain: cleanDomain },
            { uninstalledAt: null },
          ],
        },
        include: { settings: true },
      });
      if (shop) return shop;
    }
    throw error;
  }
}

export async function getMerchantSettings(shopDomain: string) {
  const shop = await getOrCreateShop(shopDomain);
  return shop.settings!;
}

export async function updateMerchantSettings(
  shopDomain: string,
  input: ShopSettingsUpdateInput
) {
  const cleanDomain = (shopDomain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim().toLowerCase();
  const shop = await getOrCreateShop(cleanDomain);

  const dataToUpdate: Record<string, any> = {};

  if (input.editingEnabled !== undefined) {
    dataToUpdate.editingEnabled = Boolean(input.editingEnabled);
  }

  if (input.editingWindowMinutes !== undefined) {
    const minutes = Number(input.editingWindowMinutes);
    if (isNaN(minutes) || minutes < 1 || minutes > 10080) {
      throw new InvalidEditRequest("editingWindowMinutes must be a positive number between 1 and 10080 (7 days).");
    }
    dataToUpdate.editingWindowMinutes = Math.floor(minutes);

    // Immediately re-calculate expiration for any active edit sessions on this shop
    try {
      const activeSessions = await prisma.orderEditSession.findMany({
        where: {
          shopId: shop.id,
          status: "ACTIVE",
        },
        include: { order: true },
      });

      for (const sess of activeSessions) {
        const orderTime = sess.order?.orderCreatedAt ? new Date(sess.order.orderCreatedAt) : new Date(sess.createdAt);
        const newExpiresAt = new Date(orderTime.getTime() + minutes * 60 * 1000);
        await prisma.orderEditSession.update({
          where: { id: sess.id },
          data: { expiresAt: newExpiresAt },
        });
      }
    } catch {
      // ignore
    }
  }

  if (input.allowQuantityChange !== undefined) {
    dataToUpdate.allowQuantityChange = Boolean(input.allowQuantityChange);
  }
  if (input.allowVariantChange !== undefined) {
    dataToUpdate.allowVariantChange = Boolean(input.allowVariantChange);
  }
  if (input.allowAddProduct !== undefined) {
    dataToUpdate.allowAddProduct = Boolean(input.allowAddProduct);
  }
  if (input.allowRemoveProduct !== undefined) {
    dataToUpdate.allowRemoveProduct = Boolean(input.allowRemoveProduct);
  }
  if (input.allowAddressChange !== undefined) {
    dataToUpdate.allowAddressChange = Boolean(input.allowAddressChange);
  }
  if (input.cancellationEnabled !== undefined) {
    dataToUpdate.cancellationEnabled = Boolean(input.cancellationEnabled);
  } else if ((input as any).allowOrderCancellation !== undefined) {
    dataToUpdate.cancellationEnabled = Boolean((input as any).allowOrderCancellation);
  }
  if (input.cancellationWindowMinutes !== undefined) {
    const minutes = Number(input.cancellationWindowMinutes);
    if (isNaN(minutes) || minutes < 1 || minutes > 10080) {
      throw new InvalidEditRequest("cancellationWindowMinutes must be a positive number between 1 and 10080 (7 days).");
    }
    dataToUpdate.cancellationWindowMinutes = Math.floor(minutes);
  }
  if (input.reorderEnabled !== undefined) {
    dataToUpdate.reorderEnabled = Boolean(input.reorderEnabled);
  }
  if (input.requirePaymentForDifference !== undefined) {
    dataToUpdate.requirePaymentForDifference = Boolean(input.requirePaymentForDifference);
  }
  if (input.allowRefundForDifference !== undefined) {
    dataToUpdate.allowRefundForDifference = Boolean(input.allowRefundForDifference);
  }
  if (input.notifyCustomer !== undefined) {
    dataToUpdate.notifyCustomer = Boolean(input.notifyCustomer);
  }
  if (input.sendEditLinkEmail !== undefined) {
    dataToUpdate.sendEditLinkEmail = Boolean(input.sendEditLinkEmail);
  }
  if (input.sendPaymentRefundEmails !== undefined) {
    dataToUpdate.sendPaymentRefundEmails = Boolean(input.sendPaymentRefundEmails);
  }
  if (input.theme !== undefined) {
    dataToUpdate.theme = String(input.theme);
  }
  if (input.supportEmail !== undefined) {
    dataToUpdate.supportEmail = input.supportEmail ? String(input.supportEmail).trim() : null;
  }

  const updated = await prisma.shopSettings.update({
    where: { shopId: shop.id },
    data: dataToUpdate as any,
  });

  // Sync to AppSettings for UI backwards-compatibility
  await prisma.appSettings.upsert({
    where: { shop: cleanDomain },
    update: {
      isActivated: updated.editingEnabled,
      editWindowHours: Math.max(1, Math.round(updated.editingWindowMinutes / 60)),
      allowQuantityChange: updated.allowQuantityChange,
      allowItemSwap: updated.allowVariantChange,
      allowAddressEdit: updated.allowAddressChange,
      allowOrderCancellation: updated.allowRemoveProduct,
      notifyMerchantOnEdit: updated.notifyCustomer,
      sendPaymentRefundEmails: (updated as any).sendPaymentRefundEmails ?? true,
      theme: (updated as any).theme ?? "Light",
      supportEmail: updated.supportEmail,
    } as any,
    create: {
      shop: cleanDomain,
      isActivated: updated.editingEnabled,
      editWindowHours: Math.max(1, Math.round(updated.editingWindowMinutes / 60)),
      allowQuantityChange: updated.allowQuantityChange,
      allowItemSwap: updated.allowVariantChange,
      allowAddressEdit: updated.allowAddressChange,
      allowOrderCancellation: updated.allowRemoveProduct,
      notifyMerchantOnEdit: updated.notifyCustomer,
      sendPaymentRefundEmails: (updated as any).sendPaymentRefundEmails ?? true,
      theme: (updated as any).theme ?? "Light",
      supportEmail: updated.supportEmail,
    } as any,
  });

  return updated;
}

import { sendSupportTicketNotification, EXPLIFIED_SUPPORT_EMAIL } from "./notification.server";

export interface CreateSupportTicketInput {
  shopDomain: string;
  shopName?: string;
  issueType: string;
  orderId?: string | null;
  description: string;
  email: string;
  attachment?: string | null;
}

export async function createSupportTicket(input: CreateSupportTicketInput) {
  const cleanDomain = input.shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const shop = await getOrCreateShop(cleanDomain);
  const ticketNumber = `TKT-${Math.floor(100000 + Math.random() * 900000)}`;
  const submittedAt = new Date();
  const status = "OPEN";

  let ticket: any;
  try {
    ticket = await (prisma as any).supportTicket.create({
      data: {
        shopDomain: cleanDomain,
        ticketNumber,
        issueType: input.issueType,
        orderId: input.orderId || null,
        description: input.description,
        email: input.email,
        attachment: input.attachment || null,
        status,
      },
    });
  } catch (error) {
    console.error("[CartMend] Error creating support ticket in DB:", error);
    ticket = {
      id: ticketNumber,
      shopDomain: cleanDomain,
      shopName: input.shopName || null,
      ticketNumber,
      issueType: input.issueType,
      orderId: input.orderId || null,
      description: input.description,
      email: input.email,
      attachment: input.attachment || null,
      status,
      createdAt: submittedAt,
      updatedAt: submittedAt,
    };
  }

  // 1. Record activity log in OrderActivity for merchant dashboard tracking
  try {
    await prisma.orderActivity.create({
      data: {
        shop: cleanDomain,
        orderId: input.orderId || "N/A",
        orderNumber: input.orderId ? (input.orderId.startsWith("#") ? input.orderId : `#${input.orderId}`) : "Support",
        customerName: input.shopName || "Store Admin",
        customerEmail: input.email,
        actionType: "SUPPORT_REQUEST",
        summary: `Support Ticket #${ticketNumber}: ${input.issueType}`,
        details: `[Status: ${status}] ${input.description.slice(0, 300)} (Attachment: ${input.attachment || "None"})`,
      },
    });
  } catch (e) {
    console.warn("[CartMend] Could not log support ticket to OrderActivity:", e);
  }

  // 2. Dispatch email notification to Explified support team (hello@explified.com)
  try {
    await sendSupportTicketNotification(shop.id, {
      shopDomain: cleanDomain,
      shopName: input.shopName,
      ticketNumber,
      issueType: input.issueType,
      orderId: input.orderId || null,
      description: input.description,
      merchantEmail: input.email,
      attachment: input.attachment || null,
      submittedAt,
      status,
    });
  } catch (e) {
    console.error(`[CartMend] Could not send support ticket notification to ${EXPLIFIED_SUPPORT_EMAIL}:`, e);
  }

  return ticket;
}

