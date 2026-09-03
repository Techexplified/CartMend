import prisma from "../db.server";
import { validateAndGetSession, validatePermissionsForChanges, RequestedEditChanges } from "./order-edit.server";
import { createShopifyGraphQLClient } from "./shopify/graphql-client.server";
import { EditSessionStatus, EditEventType, ActorType, NotificationType } from "@prisma/client";
import { OrderNotEditable, InvalidEditRequest } from "./errors";

export interface PaymentRequirementResult {
  required: boolean;
  amountDue: number;
  originalTotal: number;
  updatedTotal: number;
  currency: string;
  delta: number;
}

export interface PaymentInitiationResult {
  success: boolean;
  status: "PAYMENT_REQUIRED";
  editSessionId: string;
  orderId?: string;
  total?: number;
  difference?: number;
  originalTotal: string;
  updatedTotal: string;
  amountDue: string;
  currency: string;
  invoiceSent: boolean;
  customerEmail: string | null;
  message: string;
  paymentUrl?: string | null;
}

export interface PaymentVerificationResult {
  verified: boolean;
  status: "COMPLETED" | "PAYMENT_REQUIRED" | "FAILED";
  orderId: string;
  total: number;
  difference: number;
  currency: string;
  paymentStatus: string;
  message: string;
}

export class OrderEditPaymentService {
  /**
   * Determine payment requirement from live Shopify order and staged changes.
   */
  public static async getPaymentRequirement(
    rawToken: string,
    changes: RequestedEditChanges,
    calculatedTotal: number,
    originalTotal: number,
    currency: string
  ): Promise<PaymentRequirementResult> {
    const delta = Math.round((calculatedTotal - originalTotal) * 100) / 100;
    const required = delta > 0;

    return {
      required,
      amountDue: required ? delta : 0,
      originalTotal,
      updatedTotal: calculatedTotal,
      currency,
      delta,
    };
  }

  /**
   * Initiate the official Shopify-supported payment flow (Invoice & live server-side verification).
   * Prevents duplicate attempts using an idempotency key.
   */
  public static async initiatePaymentFlow(
    session: any,
    amountDue: number,
    finalTotal: number,
    currency: string,
    idempotencyKey?: string,
    paymentUrl?: string | null
  ): Promise<PaymentInitiationResult> {
    const cleanShopDomain = session.shop.shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const client = createShopifyGraphQLClient(cleanShopDomain);
    const idempKey = idempotencyKey || `PAY-${session.id}-${Date.now()}`;

    // 1. Check for existing payment attempt with same idempotency key
    const existingAttempt = await (prisma as any).paymentAttempt.findUnique({
      where: { idempotencyKey: idempKey },
    }).catch(() => null);

    if (existingAttempt && existingAttempt.status === "PAID") {
      return {
        success: true,
        status: "PAYMENT_REQUIRED",
        editSessionId: session.id,
        orderId: session.order.shopifyOrderId,
        total: finalTotal,
        difference: amountDue,
        originalTotal: session.originalTotal.toFixed(2),
        updatedTotal: finalTotal.toFixed(2),
        amountDue: amountDue.toFixed(2),
        currency,
        invoiceSent: true,
        customerEmail: session.order.customerEmail,
        message: "Payment attempt already initiated.",
        paymentUrl: existingAttempt.paymentUrl || session.paymentUrl || paymentUrl || null,
      };
    }

    // 2. Trigger official Shopify Invoice Email (if enabled in merchant settings)
    let invoiceSent = false;
    const shouldSendPaymentRefundEmails = (session.shop.settings as any)?.sendPaymentRefundEmails ?? true;
    if (session.order.customerEmail && shouldSendPaymentRefundEmails) {
      try {
        await client.sendOrderInvoice(session.order.shopifyOrderGid);
        invoiceSent = true;
      } catch (err: any) {
        console.warn("[CartMend Payment] Could not trigger sendOrderInvoice:", err?.message || err);
      }
    }

    // 3. Record or update PaymentAttempt
    try {
      await (prisma as any).paymentAttempt.upsert({
        where: { idempotencyKey: idempKey },
        update: {
          amount: amountDue,
          currency,
          status: "PENDING",
          paymentUrl: paymentUrl || null,
        },
        create: {
          editSessionId: session.id,
          shopId: session.shopId,
          status: "PENDING",
          amount: amountDue,
          currency,
          idempotencyKey: idempKey,
          paymentUrl: paymentUrl || null,
          metadata: {
            customerEmail: session.order.customerEmail,
            invoiceSent,
          },
        },
      });
    } catch (err) {
      console.warn("[CartMend Payment] Non-fatal PaymentAttempt upsert:", err);
    }

    // 4. Update session to PAYMENT_REQUIRED with official Shopify payment URL
    await prisma.orderEditSession.update({
      where: { id: session.id },
      data: {
        status: EditSessionStatus.PAYMENT_REQUIRED,
        paymentStatus: "REQUIRED",
        difference: amountDue,
        finalTotal,
        paymentUrl: paymentUrl || null,
      },
    });

    await prisma.order.update({
      where: { id: session.orderId },
      data: { currentTotal: finalTotal },
    });

    // 5. Record structured audit events
    await prisma.orderEditEvent.create({
      data: {
        editSessionId: session.id,
        eventType: EditEventType.PAYMENT_REQUIRED,
        actorType: ActorType.SYSTEM,
        metadata: { amountOwed: amountDue, currency, invoiceSent, paymentUrl },
      },
    });

    await prisma.orderEditEvent.create({
      data: {
        editSessionId: session.id,
        eventType: EditEventType.PAYMENT_INITIATED,
        actorType: ActorType.CUSTOMER,
        metadata: { amountOwed: amountDue, currency, idempKey, paymentUrl },
      },
    });

    // Structured Server Log
    console.log(JSON.stringify({
      event: "order_edit_payment_required",
      shop: cleanShopDomain,
      order: session.order.shopifyOrderName,
      editSessionId: session.id,
      amountDue: amountDue.toFixed(2),
      currency,
      invoiceSent,
      hasPaymentUrl: Boolean(paymentUrl),
    }));

    return {
      success: true,
      status: "PAYMENT_REQUIRED",
      editSessionId: session.id,
      orderId: session.order.shopifyOrderId,
      total: finalTotal,
      difference: amountDue,
      originalTotal: session.originalTotal.toFixed(2),
      updatedTotal: finalTotal.toFixed(2),
      amountDue: amountDue.toFixed(2),
      currency,
      invoiceSent,
      customerEmail: session.order.customerEmail,
      paymentUrl: paymentUrl || null,
      message: invoiceSent
        ? `An official Shopify invoice for +${currency} ${amountDue.toFixed(2)} has been sent to your email.`
        : `Order updated. Additional payment of ${currency} ${amountDue.toFixed(2)} is required to complete this order.`,
    };
  }

  /**
   * Verify server-side whether additional payment has been confirmed by Shopify.
   */
  public static async verifyPayment(rawToken: string): Promise<PaymentVerificationResult> {
    const session = await validateAndGetSession(rawToken, { allowCompleted: true });
    const cleanShopDomain = session.shop.shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const currency = session.order.currency || "USD";
    const amountDue = session.difference || 0;
    const finalTotal = session.finalTotal || session.originalTotal;

    // If session is already marked completed
    if (session.status === EditSessionStatus.COMPLETED) {
      return {
        verified: true,
        status: "COMPLETED",
        orderId: session.order.shopifyOrderId,
        total: finalTotal,
        difference: amountDue,
        currency,
        paymentStatus: "PAID",
        message: "Order edit has been confirmed and paid.",
      };
    }

    const client = createShopifyGraphQLClient(cleanShopDomain);

    // Query live order and transactions from Shopify
    const [liveOrder, transactionsData] = await Promise.all([
      client.getOrder(session.order.shopifyOrderGid),
      client.getOrderTransactions(session.order.shopifyOrderGid).catch(() => null),
    ]);

    if (!liveOrder) {
      throw new Error("Order not found on Shopify.");
    }

    // Check financial status and outstanding balance on Shopify
    const outstandingAmount = parseFloat(
      liveOrder.totalOutstandingSet?.shopMoney?.amount ||
      transactionsData?.totalOutstandingSet?.shopMoney?.amount ||
      "0"
    );

    const isPaidInFull =
      liveOrder.displayFinancialStatus === "PAID" &&
      outstandingAmount <= 0.01;

    // Check if any successful capture/sale transaction exists for the difference
    const recentSuccessfulTransactions = (transactionsData?.transactions || []).filter(
      (t: any) => (t.status === "SUCCESS" || t.status === "success") && (t.kind === "SALE" || t.kind === "CAPTURE")
    );

    const isPaymentConfirmed = isPaidInFull || (recentSuccessfulTransactions.length > 0 && outstandingAmount <= 0.01);

    if (isPaymentConfirmed) {
      // 1. Mark PaymentAttempt as PAID
      try {
        await (prisma as any).paymentAttempt.updateMany({
          where: {
            editSessionId: session.id,
            status: "PENDING",
          },
          data: {
            status: "PAID",
            completedAt: new Date(),
          },
        });
      } catch (err) {
        console.warn("[CartMend Payment] Non-fatal PaymentAttempt update:", err);
      }

      // 2. Mark EditSession as COMPLETED
      await prisma.orderEditSession.update({
        where: { id: session.id },
        data: {
          status: EditSessionStatus.COMPLETED,
          paymentStatus: "PAID",
          completedAt: new Date(),
        },
      });

      // 3. Record Audit Event
      await prisma.orderEditEvent.create({
        data: {
          editSessionId: session.id,
          eventType: EditEventType.PAYMENT_COMPLETED,
          actorType: ActorType.SHOPIFY,
          metadata: {
            amountPaid: amountDue,
            currency,
            financialStatus: liveOrder.displayFinancialStatus,
          },
        },
      });

      await prisma.orderEditEvent.create({
        data: {
          editSessionId: session.id,
          eventType: EditEventType.EDIT_COMPLETED,
          actorType: ActorType.SYSTEM,
          metadata: { finalTotal, difference: amountDue },
        },
      });

      console.log(JSON.stringify({
        event: "order_edit_payment_verified",
        shop: cleanShopDomain,
        order: session.order.shopifyOrderName,
        editSessionId: session.id,
        finalTotal,
        status: "COMPLETED",
      }));

      return {
        verified: true,
        status: "COMPLETED",
        orderId: session.order.shopifyOrderId,
        total: finalTotal,
        difference: amountDue,
        currency,
        paymentStatus: "PAID",
        message: "Payment successfully verified via Shopify. Your order changes are complete!",
      };
    }

    // Payment still outstanding
    return {
      verified: false,
      status: "PAYMENT_REQUIRED",
      orderId: session.order.shopifyOrderId,
      total: finalTotal,
      difference: amountDue,
      currency,
      paymentStatus: "PENDING",
      message: `Payment of ${currency} ${amountDue.toFixed(2)} is still pending on Shopify.`,
    };
  }

  /**
   * Handle price decrease / refund processing via Shopify refundCreate.
   */
  public static async handleRefund(
    session: any,
    refundAmount: number,
    currency: string,
    idempotencyKey?: string
  ) {
    const cleanShopDomain = session.shop.shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const client = createShopifyGraphQLClient(cleanShopDomain);
    const refundIdempKey = idempotencyKey || `REFUND-${session.id}-${Date.now()}`;

    const orderTransactionsData = await client.getOrderTransactions(session.order.shopifyOrderGid).catch(() => null);

    const parentTx = (orderTransactionsData?.transactions || []).find(
      (t: any) =>
        (t.kind === "SALE" || t.kind === "CAPTURE") &&
        (t.status === "SUCCESS" || t.status === "success")
    );

    let refundId: string | undefined;

    if (parentTx && parentTx.id) {
      await prisma.orderEditEvent.create({
        data: {
          editSessionId: session.id,
          eventType: EditEventType.REFUND_STARTED,
          actorType: ActorType.SYSTEM,
          metadata: {
            refundAmount,
            parentTransactionId: parentTx.id,
          },
        },
      });

      try {
        const shouldSendRefundEmail = (session.shop.settings as any)?.sendPaymentRefundEmails ?? true;
        const refundResult = await client.refundCreate({
          orderId: session.order.shopifyOrderGid,
          note: `Refund of ${currency} ${refundAmount.toFixed(2)} for customer order edit via CartMend`,
          currency,
          notify: shouldSendRefundEmail,
          transactions: [
            {
              orderId: session.order.shopifyOrderGid,
              parentId: parentTx.id,
              amount: refundAmount.toFixed(2),
              gateway: parentTx.gateway,
              kind: "REFUND",
            },
          ],
        });

        refundId = refundResult?.id;

        await prisma.orderEditEvent.create({
          data: {
            editSessionId: session.id,
            eventType: EditEventType.REFUND_COMPLETED,
            actorType: ActorType.SHOPIFY,
            metadata: {
              refundId,
              refundAmount,
              totalRefundedSet: refundResult?.totalRefundedSet,
            },
          },
        });
      } catch (refundErr: any) {
        console.error("[CartMend] Refund creation error:", refundErr?.message || refundErr);

        await prisma.orderEditEvent.create({
          data: {
            editSessionId: session.id,
            eventType: EditEventType.REFUND_FAILED,
            actorType: ActorType.SHOPIFY,
            metadata: {
              errorMessage: refundErr?.message || "Refund failed",
            },
          },
        });
      }
    }

    // Mark session as completed with refund details
    await prisma.orderEditSession.update({
      where: { id: session.id },
      data: {
        status: EditSessionStatus.COMPLETED,
        refundStatus: refundId ? "COMPLETED" : "MANUAL_REQUIRED",
        refundId: refundId || null,
        completedAt: new Date(),
      },
    });

    await prisma.orderEditEvent.create({
      data: {
        editSessionId: session.id,
        eventType: EditEventType.EDIT_COMPLETED,
        actorType: ActorType.SYSTEM,
        metadata: {
          finalTotal: session.finalTotal,
          refundAmount,
          refundId,
        },
      },
    });

    console.log(JSON.stringify({
      event: "order_edit_refund_completed",
      shop: cleanShopDomain,
      order: session.order.shopifyOrderName,
      editSessionId: session.id,
      refundAmount,
      refundId,
    }));

    return {
      success: true,
      status: "COMPLETED",
      orderId: session.order.shopifyOrderId,
      total: session.finalTotal || session.originalTotal,
      currency,
      difference: -refundAmount,
      refundAmount,
      refundId,
    };
  }
}
