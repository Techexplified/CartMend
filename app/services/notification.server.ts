import prisma from "../db.server";
import { NotificationType } from "@prisma/client";

export function generateCustomerEditUrl(shopDomain: string, rawToken: string): string {
  const cleanDomain = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${cleanDomain}/apps/cartmend/edit/${rawToken}`;
}

export interface CreateNotificationParams {
  shopId: string;
  orderId?: string;
  editSessionId?: string;
  type: NotificationType;
  recipient: string;
  status?: string;
  providerMessageId?: string;
  errorMessage?: string;
}

export async function createNotificationRecord(params: CreateNotificationParams) {
  try {
    return await prisma.notification.create({
      data: {
        shopId: params.shopId,
        orderId: params.orderId || null,
        editSessionId: params.editSessionId || null,
        type: params.type,
        recipient: params.recipient,
        status: params.status || "SENT",
        providerMessageId: params.providerMessageId || null,
        errorMessage: params.errorMessage || null,
        sentAt: new Date(),
      },
    });
  } catch (error) {
    console.error("[CartMend Notification Error]", error);
    return null;
  }
}

export const EXPLIFIED_SUPPORT_EMAIL = "hello@explified.com";

export interface SupportTicketNotificationPayload {
  shopDomain: string;
  shopName?: string;
  ticketNumber: string;
  issueType: string;
  orderId?: string | null;
  description: string;
  merchantEmail: string;
  attachment?: string | null;
  submittedAt: Date;
  status: string;
}

export async function sendSupportTicketNotification(
  shopId: string,
  payload: SupportTicketNotificationPayload
) {
  const formattedDate = payload.submittedAt.toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "full",
    timeStyle: "long",
  });

  const subject = `[CartMend Support #${payload.ticketNumber}] New Ticket: ${payload.issueType} (${payload.shopName || payload.shopDomain})`;

  const textBody = `
==================================================
           NEW CARTMEND SUPPORT TICKET
==================================================
Ticket ID:           #${payload.ticketNumber}
Ticket Status:       ${payload.status}
Submission Time:     ${formattedDate} (UTC)

----------------- STORE DETAILS ------------------
Store Domain:        ${payload.shopDomain}
Store Name:          ${payload.shopName || "N/A"}
Merchant Email:      ${payload.merchantEmail}

---------------- INQUIRY DETAILS -----------------
Issue Category:      ${payload.issueType}
Order ID:            ${payload.orderId || "N/A (General Inquiry)"}
Attachment:          ${payload.attachment || "None"}

------------------ DESCRIPTION -------------------
${payload.description}
==================================================
`.trim();

  // 1. Log structured event for telemetry and tracking
  console.log(
    JSON.stringify({
      event: "support_ticket_notification_dispatched",
      recipient: EXPLIFIED_SUPPORT_EMAIL,
      ticketNumber: payload.ticketNumber,
      shopDomain: payload.shopDomain,
      shopName: payload.shopName || null,
      merchantEmail: payload.merchantEmail,
      issueType: payload.issueType,
      orderId: payload.orderId || null,
      attachment: payload.attachment || null,
      submittedAt: payload.submittedAt.toISOString(),
      status: payload.status,
    })
  );

  // 2. Dispatch via webhook / email integration if configured
  if (process.env.SUPPORT_WEBHOOK_URL) {
    try {
      await fetch(process.env.SUPPORT_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: EXPLIFIED_SUPPORT_EMAIL,
          subject,
          text: textBody,
          data: {
            ...payload,
            submittedAt: payload.submittedAt.toISOString(),
          },
        }),
      });
    } catch (err: any) {
      console.warn("[CartMend Notification] Failed to forward ticket to SUPPORT_WEBHOOK_URL:", err?.message || err);
    }
  }

  // 3. Persist notification record in the internal database
  return await createNotificationRecord({
    shopId,
    type: NotificationType.EDIT_CONFIRMATION,
    recipient: EXPLIFIED_SUPPORT_EMAIL,
    status: "DELIVERED",
    providerMessageId: `msg_${payload.ticketNumber}_${Date.now()}`,
    errorMessage: `[Support Ticket #${payload.ticketNumber}] ${payload.issueType}`,
  });
}

