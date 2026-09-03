import prisma from "../db.server";
import crypto from "node:crypto";
import { getOrCreateShop } from "./merchant-settings.server";
import { createEditSession } from "./order-edit.server";
import { EditSessionStatus, EditEventType, ActorType } from "@prisma/client";

export interface ProcessWebhookParams {
  shopDomain: string;
  topic: string;
  shopifyWebhookId?: string | null;
  payload: Record<string, any>;
}

export async function processShopifyWebhook(params: ProcessWebhookParams) {
  const { shopDomain, topic, payload } = params;
  const cleanDomain = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const shop = await getOrCreateShop(cleanDomain);

  // Generate fallback webhook ID if not supplied
  const payloadString = JSON.stringify(payload || {});
  const payloadHash = crypto.createHash("sha256").update(payloadString).digest("hex");
  const webhookId = params.shopifyWebhookId || `${topic}-${payload?.id || payloadHash.slice(0, 16)}`;

  // Check idempotency
  const existingEvent = await prisma.webhookEvent.findUnique({
    where: {
      shopId_shopifyWebhookId: {
        shopId: shop.id,
        shopifyWebhookId: webhookId,
      },
    },
  });

  if (existingEvent && existingEvent.processed) {
    return { duplicate: true, processed: true };
  }

  // Upsert initial webhook event
  const webhookRecord = await prisma.webhookEvent.upsert({
    where: {
      shopId_shopifyWebhookId: {
        shopId: shop.id,
        shopifyWebhookId: webhookId,
      },
    },
    update: {
      topic,
      payloadHash,
      payload: payload as any,
    },
    create: {
      shopId: shop.id,
      shopifyWebhookId: webhookId,
      topic,
      payloadHash,
      payload: payload as any,
      processed: false,
    },
  });

  const normalizedTopic = (topic || "").toLowerCase().replace(/_/g, "/");

  try {
    switch (normalizedTopic) {
      case "orders/create": {
        const orderId = payload.admin_graphql_api_id || payload.id;
        if (orderId) {
          const sessionResult = await createEditSession({
            shopDomain: cleanDomain,
            orderData: {
              id: String(orderId),
              name: payload.name || `#${payload.order_number || payload.id}`,
              email: payload.email || payload.contact_email || null,
              currency: payload.currency || payload.presentment_currency || "USD",
              totalPrice: payload.total_price || payload.current_total_price || 0,
              financialStatus: payload.financial_status || null,
              fulfillmentStatus: payload.fulfillment_status || null,
              createdAt: payload.created_at || new Date(),
            },
          });

          if (sessionResult) {
            console.log(`\n======================================================`);
            console.log(`🎉 [CartMend Webhook] New Order: ${payload.name || orderId}`);
            console.log(`🔗 CUSTOMER ORDER EDIT LINK:`);
            console.log(`👉 ${sessionResult.editUrl}`);
            console.log(`   Expires: ${sessionResult.expiresAt.toISOString()}`);
            console.log(`======================================================\n`);
          } else {
            console.log(`\n📦 [CartMend Webhook] New order: ${payload.name || orderId} (Editing disabled in merchant settings)\n`);
          }
        }
        break;
      }

      case "orders/updated": {
        const rawOrderId = String(payload.id).replace("gid://shopify/Order/", "");
        const order = await prisma.order.findUnique({
          where: {
            shopId_shopifyOrderId: {
              shopId: shop.id,
              shopifyOrderId: rawOrderId,
            },
          },
        });

        if (order) {
          const isFulfilled = payload.fulfillment_status === "fulfilled" || payload.fulfillment_status === "FULFILLED";
          const isCancelled = Boolean(payload.cancelled_at);
          const isPaid = payload.financial_status === "paid" || payload.financial_status === "PAID";

          await prisma.order.update({
            where: { id: order.id },
            data: {
              currentTotal: parseFloat(String(payload.total_price || order.currentTotal)),
              financialStatus: payload.financial_status || order.financialStatus,
              fulfillmentStatus: payload.fulfillment_status || order.fulfillmentStatus,
            },
          });

          // Reconcile pending payment sessions if order has been paid
          if (isPaid) {
            const paymentPendingSession = await prisma.orderEditSession.findFirst({
              where: {
                orderId: order.id,
                status: EditSessionStatus.PAYMENT_REQUIRED,
              },
            });

            if (paymentPendingSession) {
              await prisma.orderEditSession.update({
                where: { id: paymentPendingSession.id },
                data: {
                  status: EditSessionStatus.COMPLETED,
                  paymentStatus: "PAID",
                  completedAt: new Date(),
                },
              });

              await prisma.orderEditEvent.create({
                data: {
                  editSessionId: paymentPendingSession.id,
                  eventType: EditEventType.PAYMENT_COMPLETED,
                  actorType: ActorType.SHOPIFY,
                  metadata: {
                    financialStatus: payload.financial_status,
                    totalPrice: payload.total_price,
                  },
                },
              });

              await prisma.orderEditEvent.create({
                data: {
                  editSessionId: paymentPendingSession.id,
                  eventType: EditEventType.EDIT_COMPLETED,
                  actorType: ActorType.SYSTEM,
                  metadata: {
                    reconciledViaWebhook: true,
                  },
                },
              });
            }
          }

          // If order became fulfilled or cancelled, expire any active edit session
          if (isFulfilled || isCancelled) {
            const activeSession = await prisma.orderEditSession.findFirst({
              where: {
                orderId: order.id,
                status: EditSessionStatus.ACTIVE,
              },
            });

            if (activeSession) {
              await prisma.orderEditSession.update({
                where: { id: activeSession.id },
                data: { status: isCancelled ? EditSessionStatus.CANCELLED : EditSessionStatus.EXPIRED },
              });

              await prisma.orderEditEvent.create({
                data: {
                  editSessionId: activeSession.id,
                  eventType: isCancelled ? EditEventType.SESSION_CANCELLED : EditEventType.SESSION_EXPIRED,
                  actorType: ActorType.SHOPIFY,
                  metadata: {
                    reason: isCancelled ? "Order cancelled on Shopify" : "Order fulfilled on Shopify",
                  },
                },
              });
            }
          }
        }
        break;
      }

      case "app/uninstalled": {
        await prisma.shop.update({
          where: { id: shop.id },
          data: { uninstalledAt: new Date() },
        });
        await prisma.session.deleteMany({ where: { shop: cleanDomain } });
        break;
      }

      case "customers/data_request": {
        console.log(`[Compliance] Customer data request received for shop: ${cleanDomain}, customer:`, payload?.customer?.id || payload?.customer?.email);
        break;
      }

      case "customers/redact": {
        const customerEmail = payload?.customer?.email;
        console.log(`[Compliance] Customer redact request for shop: ${cleanDomain}, customer:`, customerEmail);
        if (customerEmail) {
          try {
            await prisma.orderActivity.updateMany({
              where: { shop: cleanDomain, customerEmail },
              data: { customerName: "Redacted Customer", customerEmail: "redacted@privacy.local" },
            });
          } catch (e) {
            console.warn("[Compliance] Could not redact order activity:", e);
          }
        }
        break;
      }

      case "shop/redact": {
        console.log(`[Compliance] Shop redact request for shop: ${cleanDomain}`);
        try {
          await prisma.session.deleteMany({ where: { shop: cleanDomain } });
          const targetShop = await prisma.shop.findUnique({ where: { shopDomain: cleanDomain } });
          if (targetShop) {
            await prisma.shop.update({
              where: { id: targetShop.id },
              data: { uninstalledAt: new Date() },
            });
          }
        } catch (e) {
          console.warn("[Compliance] Could not redact shop data:", e);
        }
        break;
      }

      default:
        break;
    }

    // Mark as processed
    await prisma.webhookEvent.update({
      where: { id: webhookRecord.id },
      data: {
        processed: true,
        processedAt: new Date(),
        errorMessage: null,
      },
    });

    return { success: true, processed: true };
  } catch (error: any) {
    await prisma.webhookEvent.update({
      where: { id: webhookRecord.id },
      data: {
        processed: false,
        errorMessage: error.message || "Unknown webhook processing error",
      },
    });
    throw error;
  }
}
