import { useState, useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { getOrCreateShop, getMerchantSettings, updateMerchantSettings } from "../services/merchant-settings.server";
import { createEditSession } from "../services/order-edit.server";
import { GET_SHOP_QUERY, GET_ORDERS_QUERY } from "../services/shopify/graphql-queries";
import { EditSessionStatus, ChangeType } from "@prisma/client";

function getCurrencySymbol(currencyCode?: string): string {
  switch (currencyCode?.toUpperCase()) {
    case "INR":
      return "₹";
    case "USD":
      return "$";
    case "EUR":
      return "€";
    case "GBP":
      return "£";
    case "CAD":
      return "CA$";
    case "AUD":
      return "AU$";
    case "JPY":
      return "¥";
    default:
      return currencyCode ? `${currencyCode} ` : "$";
  }
}

const CARTMEND_EMAIL_LIQUID = `{% comment %} CartMend - Edit your order button {% endcomment %}
{% assign cartmend_edit_url = order.metafields.cartmend.edit_url %}
{% if cartmend_edit_url == blank %}
  {% assign order_ident = order.id | default: id %}
  {% if order_ident != blank %}
    {% capture cartmend_edit_url %}https://{{ shop.permanent_domain }}/apps/cartmend/api/customer/post-purchase/edit-session?order_id={{ order_ident }}&shop={{ shop.permanent_domain }}{% endcapture %}
  {% endif %}
{% endif %}

{% if cartmend_edit_url != blank %}
  <a href="{{ cartmend_edit_url }}" class="button__text" style="margin-left: 10px;">Edit your order</a>
{% endif %}`;

function formatDate(dateInput?: string | Date | null): string {
  if (!dateInput) return "—";
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatShortDate(dateInput?: string | Date | null): string {
  if (!dateInput) return "—";
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatTime(dateInput?: string | Date | null): string {
  if (!dateInput) return "—";
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const cleanDomain = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");

  // 1. Fetch Shop details via Shopify GraphQL API
  let shopDetails = {
    name: "My Shopify Store",
    currencyCode: "USD",
    email: "",
    myshopifyDomain: cleanDomain,
    primaryDomainUrl: `https://${cleanDomain}`,
  };

  try {
    const shopResponse = await admin.graphql(GET_SHOP_QUERY);
    const shopJson = (await shopResponse.json()) as any;
    if (shopJson?.data?.shop) {
      const s = shopJson.data.shop;
      shopDetails = {
        name: s.name || "My Shopify Store",
        currencyCode: s.currencyCode || "USD",
        email: s.email || "",
        myshopifyDomain: s.myshopifyDomain || cleanDomain,
        primaryDomainUrl: s.primaryDomain?.url || `https://${cleanDomain}`,
      };
    }
  } catch (err) {
    console.error("[CartMend] Error querying shop details from GraphQL:", err);
  }

  // 2. Fetch or initialize Merchant Settings and Shop in DB
  const shopRecord = await getOrCreateShop(cleanDomain);
  const merchantSettings = await getMerchantSettings(cleanDomain);

  let appSettings = await prisma.appSettings.findUnique({
    where: { shop: cleanDomain },
  });

  if (!appSettings) {
    appSettings = await prisma.appSettings.create({
      data: {
        shop: cleanDomain,
        isActivated: merchantSettings.editingEnabled,
        editWindowHours: Math.round(merchantSettings.editingWindowMinutes / 60) || 24,
        allowAddressEdit: merchantSettings.allowAddressChange,
        allowQuantityChange: merchantSettings.allowQuantityChange,
        allowItemSwap: merchantSettings.allowVariantChange,
        allowOrderCancellation: true,
      },
    });
  }

  // 3. Fetch Orders with full product details from Shopify GraphQL API
  let shopifyOrders: any[] = [];
  try {
    const ordersResponse = await admin.graphql(GET_ORDERS_QUERY, {
      variables: { first: 25 },
    });
    const ordersJson = (await ordersResponse.json()) as any;
    if (ordersJson?.data?.orders?.edges) {
      shopifyOrders = ordersJson.data.orders.edges.map((e: any) => e.node);
    }
  } catch (err) {
    console.error("[CartMend] Error querying orders from Shopify GraphQL API:", err);
  }

  // 4. Fetch CartMend database records (OrderEditSessions, OrderEditChanges, Events, OrderActivity)
  const editSessions = await prisma.orderEditSession.findMany({
    where: { shopId: shopRecord.id },
    include: {
      order: true,
      changes: true,
      events: { orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const orderActivities = await prisma.orderActivity.findMany({
    where: { shop: cleanDomain },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  // 5. Build lookup map of Shopify order details by order name and order ID
  const shopifyOrderMap = new Map<string, any>();
  for (const o of shopifyOrders) {
    const rawId = o.id ? o.id.replace("gid://shopify/Order/", "") : "";
    if (o.name) shopifyOrderMap.set(o.name, o);
    if (rawId) shopifyOrderMap.set(rawId, o);
    if (o.id) shopifyOrderMap.set(o.id, o);
  }

  // 6. Generate Real Time-Series Chart Data (Last 7 Days)
  const daysCount = 7;
  const chartDays: Array<{
    day: string;
    dateKey: string;
    edits: number;
    cancellations: number;
    label: string;
  }> = [];

  const now = new Date();
  for (let i = daysCount - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(now.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    chartDays.push({
      day: label,
      dateKey,
      edits: 0,
      cancellations: 0,
      label,
    });
  }

  // Group edit sessions by dateKey
  for (const s of editSessions) {
    const sessionDateKey = new Date(s.createdAt).toISOString().slice(0, 10);
    const match = chartDays.find((cd) => cd.dateKey === sessionDateKey);
    if (match) {
      if (s.status === EditSessionStatus.COMPLETED || s.status === EditSessionStatus.ACTIVE) {
        match.edits += 1;
      }
      if (s.status === EditSessionStatus.CANCELLED) {
        match.cancellations += 1;
      }
    }
  }

  // Group order activities by dateKey
  for (const act of orderActivities) {
    const actDateKey = new Date(act.createdAt).toISOString().slice(0, 10);
    const match = chartDays.find((cd) => cd.dateKey === actDateKey);
    if (match) {
      if (act.actionType.toLowerCase().includes("cancel")) {
        match.cancellations += 1;
      } else {
        match.edits += 1;
      }
    }
  }

  // 7. Generate Real Edit Types Breakdown (Address, Variants/Items, Quantity, Cancellations)
  let countAddress = 0;
  let countVariant = 0;
  let countQuantity = 0;
  let countCancel = editSessions.filter((s) => s.status === EditSessionStatus.CANCELLED).length;

  for (const s of editSessions) {
    for (const ch of s.changes) {
      if (ch.changeType === ChangeType.CHANGE_ADDRESS) countAddress++;
      else if (ch.changeType === ChangeType.CHANGE_VARIANT || ch.changeType === ChangeType.ADD_PRODUCT) countVariant++;
      else if (ch.changeType === ChangeType.CHANGE_QUANTITY) countQuantity++;
      else if (ch.changeType === ChangeType.REMOVE_PRODUCT) countCancel++;
    }
  }

  for (const act of orderActivities) {
    const t = act.actionType.toLowerCase();
    if (t.includes("address")) countAddress++;
    else if (t.includes("item") || t.includes("variant") || t.includes("swap")) countVariant++;
    else if (t.includes("quantity") || t.includes("qty")) countQuantity++;
    else if (t.includes("cancel")) countCancel++;
  }

  const totalBreakdownCount = countAddress + countVariant + countQuantity + countCancel;

  const breakdownData = {
    address: {
      count: countAddress,
      percentage: totalBreakdownCount > 0 ? ((countAddress / totalBreakdownCount) * 100).toFixed(1) : "0.0",
    },
    variant: {
      count: countVariant,
      percentage: totalBreakdownCount > 0 ? ((countVariant / totalBreakdownCount) * 100).toFixed(1) : "0.0",
    },
    quantity: {
      count: countQuantity,
      percentage: totalBreakdownCount > 0 ? ((countQuantity / totalBreakdownCount) * 100).toFixed(1) : "0.0",
    },
    cancel: {
      count: countCancel,
      percentage: totalBreakdownCount > 0 ? ((countCancel / totalBreakdownCount) * 100).toFixed(1) : "0.0",
    },
    total: totalBreakdownCount,
  };

  // 8. Build Unified Real Order Activity List Enriched with Shopify Products
  interface UnifiedActivity {
    id: string;
    orderId: string;
    orderNumber: string;
    customerName: string;
    customerEmail: string;
    actionType: string;
    actionCategory: "item" | "address" | "quantity" | "cancel" | "new";
    changes: string;
    amountImpact: string;
    amountImpactValue: number;
    amountType: "positive" | "negative" | "neutral";
    status: string;
    dateTime: string;
    rawDate: string;
    shippingAddress?: string;
    lineItems: Array<{
      id: string;
      title: string;
      variantTitle?: string;
      quantity: number;
      price: string;
      imageUrl?: string;
    }>;
    changeDetails: Array<{
      type: string;
      desc: string;
    }>;
    auditEvents: Array<{
      event: string;
      actor: string;
      time: string;
    }>;
  }

  const unifiedActivities: UnifiedActivity[] = [];

  // Add from editSessions
  for (const s of editSessions) {
    const rawOrderId = s.order?.shopifyOrderId || "";
    const matchedShopifyOrder = shopifyOrderMap.get(s.order?.shopifyOrderName || "") || shopifyOrderMap.get(rawOrderId);

    let category: "item" | "address" | "quantity" | "cancel" | "new" = "item";
    let actionType = "Order edit";
    const changeDetails: Array<{ type: string; desc: string }> = [];

    for (const ch of s.changes) {
      if (ch.changeType === ChangeType.CHANGE_ADDRESS) {
        category = "address";
        actionType = "Address changed";
        changeDetails.push({ type: "Shipping Address", desc: "Customer updated shipping address" });
      } else if (ch.changeType === ChangeType.CHANGE_VARIANT) {
        category = "item";
        actionType = "Item swapped";
        changeDetails.push({
          type: "Variant Swap",
          desc: `Swapped variant to ${ch.newVariantId || "new selection"} (Qty: ${ch.newQuantity || 1})`,
        });
      } else if (ch.changeType === ChangeType.ADD_PRODUCT) {
        category = "item";
        actionType = "Item added";
        changeDetails.push({
          type: "Product Added",
          desc: `Added variant ${ch.shopifyVariantId || "new item"} (Qty: ${ch.newQuantity || 1})`,
        });
      } else if (ch.changeType === ChangeType.CHANGE_QUANTITY) {
        category = "quantity";
        actionType = "Quantity changed";
        changeDetails.push({
          type: "Quantity Update",
          desc: `Qty ${ch.oldQuantity ?? "?"} → Qty ${ch.newQuantity ?? "?"}`,
        });
      } else if (ch.changeType === ChangeType.REMOVE_PRODUCT) {
        category = "cancel";
        actionType = "Item removed";
        changeDetails.push({
          type: "Item Removal",
          desc: "Item removed from order",
        });
      }
    }

    if (s.status === EditSessionStatus.CANCELLED) {
      category = "cancel";
      actionType = "Order cancelled";
    }

    const diff = (s.difference !== null && s.difference !== undefined) ? s.difference : (s.finalTotal !== null && s.finalTotal !== undefined && s.originalTotal !== null && s.originalTotal !== undefined ? Math.round((s.finalTotal - s.originalTotal) * 100) / 100 : 0);
    const currencySym = getCurrencySymbol(s.order?.currency || shopDetails.currencyCode);
    const amountImpact = diff > 0 ? `+${currencySym}${diff.toFixed(2)}` : diff < 0 ? `-${currencySym}${Math.abs(diff).toFixed(2)}` : "—";
    const amountType: "positive" | "negative" | "neutral" = diff > 0 ? "positive" : diff < 0 ? "negative" : "neutral";

    const extractedLineItems: UnifiedActivity["lineItems"] = [];
    if (matchedShopifyOrder?.lineItems?.edges) {
      for (const edge of matchedShopifyOrder.lineItems.edges) {
        const node = edge.node;
        extractedLineItems.push({
          id: node.id,
          title: node.title,
          variantTitle: node.variant?.title !== "Default Title" ? node.variant?.title : undefined,
          quantity: node.currentQuantity || node.quantity || 1,
          price: node.originalUnitPriceSet?.shopMoney?.amount || node.variant?.price || "0.00",
          imageUrl: node.image?.url || node.variant?.image?.url || node.variant?.product?.featuredImage?.url,
        });
      }
    }

    const auditEvents = s.events.map((ev) => ({
      event: ev.eventType.replace(/_/g, " "),
      actor: ev.actorType,
      time: formatDate(ev.createdAt),
    }));

    unifiedActivities.push({
      id: s.id,
      orderId: s.order?.shopifyOrderId || s.id,
      orderNumber: s.order?.shopifyOrderName || `#${s.id.slice(0, 6)}`,
      customerName: matchedShopifyOrder?.customer?.displayName || (matchedShopifyOrder?.customer?.firstName ? `${matchedShopifyOrder.customer.firstName || ""} ${matchedShopifyOrder.customer.lastName || ""}`.trim() : s.order?.customerEmail ? s.order.customerEmail.split("@")[0] : "Customer"),
      customerEmail: s.order?.customerEmail || matchedShopifyOrder?.email || "",
      actionType,
      actionCategory: category,
      changes: changeDetails.length > 0 ? changeDetails.map((c) => c.desc).join(", ") : s.status === EditSessionStatus.CANCELLED ? "Full order cancellation" : "Order edit session active",
      amountImpact,
      amountImpactValue: diff,
      amountType,
      status: s.status === EditSessionStatus.COMPLETED ? "Completed" : s.status === EditSessionStatus.CANCELLED ? "Cancelled" : s.status === EditSessionStatus.ACTIVE ? "In Progress" : s.status === EditSessionStatus.EXPIRED ? "Expired" : s.status,
      dateTime: formatDate(s.completedAt || s.createdAt),
      rawDate: (s.completedAt || s.createdAt).toISOString(),
      shippingAddress: matchedShopifyOrder?.shippingAddress?.formatted?.join(", ") || undefined,
      lineItems: extractedLineItems,
      changeDetails,
      auditEvents,
    });
  }

  // Add from orderActivities if not already present
  for (const act of orderActivities) {
    if (!unifiedActivities.some((u) => u.orderNumber === act.orderNumber || u.orderId === act.orderId)) {
      const matchedShopifyOrder = shopifyOrderMap.get(act.orderNumber) || shopifyOrderMap.get(act.orderId);
      const diff = act.previousTotal !== null && act.newTotal !== null && act.previousTotal !== undefined && act.newTotal !== undefined && act.previousTotal > 0 ? Math.round((act.newTotal - act.previousTotal) * 100) / 100 : 0;
      const currencySym = getCurrencySymbol(shopDetails.currencyCode);
      const amountImpact = diff > 0 ? `+${currencySym}${diff.toFixed(2)}` : diff < 0 ? `-${currencySym}${Math.abs(diff).toFixed(2)}` : "—";
      const amountType: "positive" | "negative" | "neutral" = diff > 0 ? "positive" : diff < 0 ? "negative" : "neutral";

      let cat: "item" | "address" | "quantity" | "cancel" | "new" = "item";
      const t = act.actionType.toLowerCase();
      if (t.includes("address")) cat = "address";
      else if (t.includes("quantity")) cat = "quantity";
      else if (t.includes("cancel")) cat = "cancel";

      const extractedLineItems: UnifiedActivity["lineItems"] = [];
      if (matchedShopifyOrder?.lineItems?.edges) {
        for (const edge of matchedShopifyOrder.lineItems.edges) {
          const node = edge.node;
          extractedLineItems.push({
            id: node.id,
            title: node.title,
            variantTitle: node.variant?.title !== "Default Title" ? node.variant?.title : undefined,
            quantity: node.currentQuantity || node.quantity || 1,
            price: node.originalUnitPriceSet?.shopMoney?.amount || node.variant?.price || "0.00",
            imageUrl: node.image?.url || node.variant?.image?.url || node.variant?.product?.featuredImage?.url,
          });
        }
      }

      unifiedActivities.push({
        id: act.id,
        orderId: act.orderId,
        orderNumber: act.orderNumber,
        customerName: act.customerName || (matchedShopifyOrder?.customer?.displayName || "Customer"),
        customerEmail: act.customerEmail || matchedShopifyOrder?.email || "",
        actionType: act.actionType,
        actionCategory: cat,
        changes: act.summary || "Order updated",
        amountImpact,
        amountImpactValue: diff,
        amountType,
        status: act.actionType.toLowerCase().includes("cancel") ? "Refunded" : "Completed",
        dateTime: formatDate(act.createdAt),
        rawDate: act.createdAt.toISOString(),
        shippingAddress: matchedShopifyOrder?.shippingAddress?.formatted?.join(", ") || undefined,
        lineItems: extractedLineItems,
        changeDetails: [{ type: act.actionType, desc: act.summary || "" }],
        auditEvents: [{ event: act.actionType, actor: "CUSTOMER", time: formatDate(act.createdAt) }],
      });
    }
  }

  // Also include recent Shopify orders if we have room, so live store orders show up immediately!
  for (const o of shopifyOrders) {
    const rawId = o.id.replace("gid://shopify/Order/", "");
    if (!unifiedActivities.some((u) => u.orderNumber === o.name || u.orderId === rawId)) {
      const extractedLineItems: UnifiedActivity["lineItems"] = [];
      if (o.lineItems?.edges) {
        for (const edge of o.lineItems.edges) {
          const node = edge.node;
          extractedLineItems.push({
            id: node.id,
            title: node.title,
            variantTitle: node.variant?.title !== "Default Title" ? node.variant?.title : undefined,
            quantity: node.currentQuantity || node.quantity || 1,
            price: node.originalUnitPriceSet?.shopMoney?.amount || node.variant?.price || "0.00",
            imageUrl: node.image?.url || node.variant?.image?.url || node.variant?.product?.featuredImage?.url,
          });
        }
      }

      const totalAmt = parseFloat(o.totalPriceSet?.shopMoney?.amount || "0.00");
      const currencySym = getCurrencySymbol(o.currencyCode || shopDetails.currencyCode);
      const isCancelled = Boolean(o.cancelledAt);

      unifiedActivities.push({
        id: `shopify-${rawId}`,
        orderId: rawId,
        orderNumber: o.name,
        customerName: o.customer?.displayName || (o.customer?.firstName ? `${o.customer.firstName} ${o.customer.lastName || ""}`.trim() : "Customer"),
        customerEmail: o.email || o.customer?.email || "",
        actionType: isCancelled ? "Order cancelled" : "Order placed",
        actionCategory: isCancelled ? "cancel" : "new",
        changes: isCancelled ? (o.cancelReason || "Order cancelled on Shopify") : `${extractedLineItems.length} item${extractedLineItems.length === 1 ? "" : "s"} (${currencySym}${totalAmt.toFixed(2)})`,
        amountImpact: "—",
        amountImpactValue: 0,
        amountType: "neutral",
        status: isCancelled ? "Cancelled" : o.displayFulfillmentStatus === "FULFILLED" ? "Fulfilled" : "Placed",
        dateTime: formatDate(o.createdAt),
        rawDate: o.createdAt,
        shippingAddress: o.shippingAddress?.formatted?.join(", ") || undefined,
        lineItems: extractedLineItems,
        changeDetails: [],
        auditEvents: [{ event: isCancelled ? "ORDER_CANCELLED" : "ORDER_CREATED", actor: "SHOPIFY", time: formatDate(o.createdAt) }],
      });
    }
  }

  // Sort unified activities chronologically (newest first)
  unifiedActivities.sort((a, b) => new Date(b.rawDate).getTime() - new Date(a.rawDate).getTime());

  // 9. Calculate Clean Accurate KPIs directly from unifiedActivities
  const totalEditsCount = unifiedActivities.filter(
    (a) => a.actionCategory === "item" || a.actionCategory === "address" || a.actionCategory === "quantity"
  ).length;

  const cancellationsCount = unifiedActivities.filter(
    (a) => a.actionCategory === "cancel" || a.actionType.toLowerCase().includes("cancel")
  ).length;

  let additionalPaymentsTotal = 0;
  let refundsIssuedTotal = 0;
  let additionalPaymentsCount = 0;
  let refundsIssuedCount = 0;

  for (const act of unifiedActivities) {
    if (act.amountImpactValue > 0) {
      additionalPaymentsTotal += act.amountImpactValue;
      additionalPaymentsCount += 1;
    } else if (act.amountImpactValue < 0) {
      refundsIssuedTotal += Math.abs(act.amountImpactValue);
      refundsIssuedCount += 1;
    }
  }

  // 10. Hardcoded Recent Order for Setup Guide & Onboarding Card Showcase
  const recentOrderPreview: {
    id: string;
    name: string;
    placedOnFormatted: string;
    editingAvailableUntilFormatted: string;
    itemsCount: number;
    totalFormatted: string;
    isEligible: boolean;
    eligibilityReason: string;
    lineItems: UnifiedActivity["lineItems"];
  } = {
    id: "1011",
    name: "#1011",
    placedOnFormatted: "Aug 25, 2026",
    editingAvailableUntilFormatted: "Aug 25, 2026, 11:34 PM",
    itemsCount: 1,
    totalFormatted: "$57.00",
    isEligible: true,
    eligibilityReason: "Eligible for editing",
    lineItems: [
      {
        id: "demo-item-1011",
        title: "Classic Plaid Flannel Overshirt",
        variantTitle: "Forest Green / M",
        quantity: 1,
        price: "57.00",
        imageUrl: "https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=120&auto=format&fit=crop&q=80",
      },
    ],
  };

  const url = new URL(request.url);
  const rulesConfiguredParam = url.searchParams.get("rulesConfigured") === "true";
  const rulesSavedInDb = appSettings.supportEmail && appSettings.supportEmail.includes("rulesConfigured");
  const isRulesConfigured = rulesConfiguredParam || Boolean(rulesSavedInDb);

  return {
    shop: cleanDomain,
    shopDetails,
    merchantSettings,
    appSettings,
    isRulesConfigured,
    isEmailSetupCompleted: Boolean(merchantSettings.sendEditLinkEmail),
    kpis: {
      totalEdits: totalEditsCount,
      cancellations: cancellationsCount,
      additionalPayments: additionalPaymentsTotal,
      additionalPaymentsCount,
      refundsIssued: refundsIssuedTotal,
      refundsIssuedCount,
      currencySymbol: getCurrencySymbol(shopDetails.currencyCode),
    },
    chartDays,
    breakdownData,
    activities: unifiedActivities,
    recentOrderPreview,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const shopDomain = session.shop.replace(/^https?:\/\//, "").replace(/\/$/, "");

  if (intent === "toggle_activation") {
    const currentStatus = formData.get("currentStatus") === "true";
    const nextStatus = !currentStatus;

    await updateMerchantSettings(shopDomain, { editingEnabled: nextStatus });

    await prisma.appSettings.upsert({
      where: { shop: shopDomain },
      update: { isActivated: nextStatus },
      create: {
        shop: shopDomain,
        isActivated: nextStatus,
      },
    });

    return {
      success: true,
      isActivated: nextStatus,
      message: nextStatus
        ? "CartMend is now Active and order editing is enabled!"
        : "CartMend order editing has been deactivated.",
    };
  }

  if (intent === "toggle_email_setup") {
    const isCompleted = formData.get("isCompleted") === "true";
    await updateMerchantSettings(shopDomain, { sendEditLinkEmail: isCompleted });
    return {
      success: true,
      emailSetupCompleted: isCompleted,
      message: isCompleted
        ? "Email setup marked as complete!"
        : "Email setup status updated to pending.",
    };
  }

  if (intent === "create_test_session") {
    const orderId = String(formData.get("orderId") || "");
    const orderName = String(formData.get("orderName") || `#${orderId}`);
    const orderTotal = parseFloat(String(formData.get("orderTotal") || "0"));

    if (orderId) {
      const sessionResult = await createEditSession({
        shopDomain,
        orderData: {
          id: orderId,
          name: orderName,
          totalPrice: orderTotal,
          createdAt: new Date(),
        },
      });

      if (sessionResult) {
        return {
          success: true,
          editUrl: sessionResult.editUrl,
          message: `Customer Edit Link generated for ${orderName}!`,
        };
      }
    }
  }

  return null;
};

export default function CartMendDashboard() {
  const {
    shop,
    shopDetails,
    merchantSettings,
    appSettings,
    isRulesConfigured,
    isEmailSetupCompleted,
    kpis,
    chartDays,
    breakdownData,
    activities,
    recentOrderPreview,
  } = useLoaderData<typeof loader>();

  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [dateRange, setDateRange] = useState("Last 7 Days");
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const [chartMetric, setChartMetric] = useState<"edits" | "cancellations">("edits");
  const [breakdownType, setBreakdownType] = useState<"count" | "percentage">("count");
  const [selectedActivity, setSelectedActivity] = useState<typeof activities[0] | null>(null);

  const [copiedLiquid, setCopiedLiquid] = useState(false);
  const isEmailSetupDone = fetcher.data && "emailSetupCompleted" in fetcher.data
    ? Boolean((fetcher.data as any).emailSetupCompleted)
    : isEmailSetupCompleted;

  const handleCopyCode = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(CARTMEND_EMAIL_LIQUID).then(() => {
        setCopiedLiquid(true);
        shopify.toast.show("Liquid code copied to clipboard!");
        setTimeout(() => setCopiedLiquid(false), 2500);
      });
    }
  };

  const handleToggleEmailSetup = (checked: boolean) => {
    fetcher.submit(
      { intent: "toggle_email_setup", isCompleted: String(checked) },
      { method: "POST" }
    );
  };

  const isActivated = fetcher.data && "isActivated" in fetcher.data
    ? (fetcher.data as any).isActivated
    : merchantSettings.editingEnabled;
  const [activeTab, setActiveTab] = useState<"dashboard" | "onboarding">(
    isActivated ? "dashboard" : "onboarding"
  );


  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message);
      if ("isActivated" in fetcher.data && (fetcher.data as any).isActivated) {
        setActiveTab("dashboard");
      }
    }
  }, [fetcher.data, shopify]);

  const handleToggleActivation = () => {
    fetcher.submit(
      { intent: "toggle_activation", currentStatus: String(isActivated) },
      { method: "POST" }
    );
  };

  // Dynamic Chart SVG Scaling
  const svgWidth = 480;
  const svgHeight = 160;
  const paddingX = 35;
  const paddingY = 25;

  const maxValInSeries = Math.max(...chartDays.map((d) => (chartMetric === "cancellations" ? d.cancellations : d.edits)), 0);
  const maxY = Math.max(maxValInSeries > 0 ? Math.ceil(maxValInSeries * 1.3) : 10, 5);

  const points = chartDays.map((d, index) => {
    const x = paddingX + (index * (svgWidth - paddingX * 2)) / Math.max(chartDays.length - 1, 1);
    const val = chartMetric === "cancellations" ? d.cancellations : d.edits;
    const y = svgHeight - paddingY - (val / maxY) * (svgHeight - paddingY * 2);
    return { x, y, val, day: d.day };
  });

  const pathD = points.reduce((acc, p, idx) => (idx === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`), "");
  const areaD = points.length > 0 ? `${pathD} L ${points[points.length - 1].x} ${svgHeight - paddingY} L ${points[0].x} ${svgHeight - paddingY} Z` : "";

  // Dynamic SVG Donut Chart Calculation
  const totalBd = breakdownData.total || 0;
  const pAddress = totalBd > 0 ? parseFloat(breakdownData.address.percentage) : 0;
  const pVariant = totalBd > 0 ? parseFloat(breakdownData.variant.percentage) : 0;
  const pQuantity = totalBd > 0 ? parseFloat(breakdownData.quantity.percentage) : 0;
  const pCancel = totalBd > 0 ? parseFloat(breakdownData.cancel.percentage) : 0;

  const offAddress = 0;
  const offVariant = -pAddress;
  const offQuantity = -(pAddress + pVariant);
  const offCancel = -(pAddress + pVariant + pQuantity);

  return (
    <div className="cartmend-container">
      {/* Top Header */}
      <div className="cm-dash-header">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <h1 className="cm-title" style={{ margin: 0 }}>
              {activeTab === "dashboard" ? "Dashboard" : "Welcome to CartMend"}
            </h1>
            {/* View Mode Switcher Pill */}
            <div style={{ display: "inline-flex", background: "#e8eaed", borderRadius: "20px", padding: "2px" }}>
              <button
                type="button"
                onClick={() => setActiveTab("dashboard")}
                style={{
                  border: "none",
                  background: activeTab === "dashboard" ? "#ffffff" : "transparent",
                  color: activeTab === "dashboard" ? "#1a1a1a" : "#5c5f62",
                  fontSize: "11.5px",
                  fontWeight: 600,
                  padding: "3px 10px",
                  borderRadius: "18px",
                  cursor: "pointer",
                  boxShadow: activeTab === "dashboard" ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
                }}
              >
                Analytics
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("onboarding")}
                style={{
                  border: "none",
                  background: activeTab === "onboarding" ? "#ffffff" : "transparent",
                  color: activeTab === "onboarding" ? "#1a1a1a" : "#5c5f62",
                  fontSize: "11.5px",
                  fontWeight: 600,
                  padding: "3px 10px",
                  borderRadius: "18px",
                  cursor: "pointer",
                  boxShadow: activeTab === "onboarding" ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
                }}
              >
                Setup Guide
              </button>
            </div>
            {isActivated && (
              <span className="cm-live-dot" title="CartMend is actively processing customer order edits" />
            )}
          </div>
          <p className="cm-subtitle">
            {activeTab === "dashboard"
              ? `Live order editing analytics and activity for ${shopDetails.name}.`
              : "Let your customers edit their orders on their own—safely, flexibly, and without extra support tickets."}
          </p>
        </div>

        {/* Date Range Selector */}
        {activeTab === "dashboard" && (
          <div>
            <button
              type="button"
              className="cm-date-btn"
              onClick={() => setIsDatePickerOpen(true)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              <span>{dateRange}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "12px", height: "12px" }}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {activeTab === "dashboard" ? (
        <>
          {/* 4 Real KPI Metric Cards */}
          <div className="cm-metrics-grid">
            {/* Card 1: Total edits */}
            <div className="cm-metric-card">
              <div className="cm-metric-icon green">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  <path d="m15 5 4 4" />
                </svg>
              </div>
              <div className="cm-metric-body">
                <div className="cm-metric-label">Total edits</div>
                <div className="cm-metric-value">{kpis.totalEdits}</div>
                <div className="cm-metric-trend cm-trend-up">
                  <span>{kpis.totalEdits > 0 ? "↑ Active" : "— Real-time"}</span>
                  <span className="cm-trend-sub">tracked in store</span>
                </div>
              </div>
            </div>

            {/* Card 2: Cancellations */}
            <div className="cm-metric-card">
              <div className="cm-metric-icon purple">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m7.5 4.27 9 5.15" />
                  <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                  <path d="m3.3 7 8.7 5 8.7-5" />
                  <path d="M12 22V12" />
                </svg>
              </div>
              <div className="cm-metric-body">
                <div className="cm-metric-label">Cancellations</div>
                <div className="cm-metric-value">{kpis.cancellations}</div>
                <div className="cm-metric-trend cm-trend-up">
                  <span>{kpis.cancellations > 0 ? "↑ Synced" : "0"}</span>
                  <span className="cm-trend-sub">auto-processed</span>
                </div>
              </div>
            </div>

            {/* Card 3: Additional payments */}
            <div className="cm-metric-card">
              <div className="cm-metric-icon blue">
                <span style={{ fontSize: "16px", fontWeight: 700 }}>{kpis.currencySymbol}</span>
              </div>
              <div className="cm-metric-body">
                <div className="cm-metric-label">Additional payments</div>
                <div className="cm-metric-value">
                  {kpis.currencySymbol}{kpis.additionalPayments.toFixed(2)}
                </div>
                <div className={`cm-metric-trend ${kpis.additionalPaymentsCount > 0 ? "cm-trend-up" : ""}`}>
                  <span>{kpis.additionalPaymentsCount > 0 ? `↑ ${kpis.additionalPaymentsCount}` : "0"}</span>
                  <span className="cm-trend-sub">Upgrade{kpis.additionalPaymentsCount === 1 ? "" : "s"} collected</span>
                </div>
              </div>
            </div>

            {/* Card 4: Refunds issued */}
            <div className="cm-metric-card">
              <div className="cm-metric-icon orange">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                  <path d="M8 16H3v5" />
                </svg>
              </div>
              <div className="cm-metric-body">
                <div className="cm-metric-label">Refunds issued</div>
                <div className="cm-metric-value">
                  {kpis.currencySymbol}{kpis.refundsIssued.toFixed(2)}
                </div>
                <div className={`cm-metric-trend ${kpis.refundsIssuedCount > 0 ? "cm-trend-down" : ""}`}>
                  <span>{kpis.refundsIssuedCount > 0 ? `↓ ${kpis.refundsIssuedCount}` : "0"}</span>
                  <span className="cm-trend-sub">Reduction{kpis.refundsIssuedCount === 1 ? "" : "s"} processed</span>
                </div>
              </div>
            </div>
          </div>

          {/* Middle 2 Charts Grid */}
          <div className="cm-charts-grid">
            {/* Left Chart: Edits over time */}
            <div className="cm-chart-card">
              <div className="cm-chart-header">
                <div className="cm-chart-title">
                  <span>Edits over time</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                </div>
                <select
                  value={chartMetric}
                  onChange={(e) => setChartMetric(e.target.value as any)}
                  className="cm-chart-select"
                >
                  <option value="edits">Total edits</option>
                  <option value="cancellations">Cancellations</option>
                </select>
              </div>

              {/* Dynamic SVG Line & Area Chart */}
              <div style={{ width: "100%", height: "160px", position: "relative" }}>
                <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} style={{ width: "100%", height: "100%", overflow: "visible" }}>
                  <defs>
                    <linearGradient id="cmGreenGradLive" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#008060" stopOpacity="0.18" />
                      <stop offset="100%" stopColor="#008060" stopOpacity="0.01" />
                    </linearGradient>
                  </defs>

                  {/* Horizontal Gridlines & Y-Axis Labels */}
                  {[maxY, Math.round(maxY * 0.75), Math.round(maxY * 0.5), Math.round(maxY * 0.25), 0].map((tick, idx) => {
                    const y = svgHeight - paddingY - (tick / maxY) * (svgHeight - paddingY * 2);
                    return (
                      <g key={`${tick}-${idx}`}>
                        <line x1={paddingX} y1={y} x2={svgWidth - paddingX} y2={y} stroke="#f1f2f4" strokeWidth="1" />
                        <text x={paddingX - 10} y={y + 3.5} fill="#94a3b8" fontSize="10.5" textAnchor="end" fontFamily="sans-serif">
                          {tick}
                        </text>
                      </g>
                    );
                  })}

                  {/* Area fill */}
                  {areaD && <path d={areaD} fill="url(#cmGreenGradLive)" />}

                  {/* Line stroke */}
                  {pathD && <path d={pathD} fill="none" stroke="#008060" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />}

                  {/* Data Point Circles */}
                  {points.map((p, i) => (
                    <g key={i}>
                      <circle cx={p.x} cy={p.y} r="4" fill="#008060" stroke="#ffffff" strokeWidth="2" style={{ cursor: "pointer" }} />
                      <text x={p.x} y={svgHeight - 6} fill="#64748b" fontSize="10.5" textAnchor="middle" fontFamily="sans-serif">
                        {p.day}
                      </text>
                    </g>
                  ))}
                </svg>
              </div>
            </div>

            {/* Right Chart: Edit types breakdown */}
            <div className="cm-chart-card">
              <div className="cm-chart-header">
                <div className="cm-chart-title">Edit types breakdown</div>
                <select
                  value={breakdownType}
                  onChange={(e) => setBreakdownType(e.target.value as any)}
                  className="cm-chart-select"
                >
                  <option value="count">By count</option>
                  <option value="percentage">By percentage</option>
                </select>
              </div>

              <div className="cm-breakdown-body">
                {/* Dynamic SVG Donut Chart */}
                <div className="cm-donut-wrap">
                  <svg viewBox="0 0 100 100" style={{ width: "100%", height: "100%", transform: "rotate(-90deg)" }}>
                    {totalBd === 0 ? (
                      <circle cx="50" cy="50" r="38" fill="transparent" stroke="#e2e8f0" strokeWidth="18" />
                    ) : (
                      <>
                        {pAddress > 0 && (
                          <circle cx="50" cy="50" r="38" fill="transparent" stroke="#008060" strokeWidth="18" strokeDasharray={`${pAddress} ${100 - pAddress}`} strokeDashoffset={offAddress} />
                        )}
                        {pVariant > 0 && (
                          <circle cx="50" cy="50" r="38" fill="transparent" stroke="#2563eb" strokeWidth="18" strokeDasharray={`${pVariant} ${100 - pVariant}`} strokeDashoffset={offVariant} />
                        )}
                        {pQuantity > 0 && (
                          <circle cx="50" cy="50" r="38" fill="transparent" stroke="#7c3aed" strokeWidth="18" strokeDasharray={`${pQuantity} ${100 - pQuantity}`} strokeDashoffset={offQuantity} />
                        )}
                        {pCancel > 0 && (
                          <circle cx="50" cy="50" r="38" fill="transparent" stroke="#f97316" strokeWidth="18" strokeDasharray={`${pCancel} ${100 - pCancel}`} strokeDashoffset={offCancel} />
                        )}
                      </>
                    )}
                  </svg>
                </div>

                {/* Legend List */}
                <div className="cm-legend-wrap">
                  <div className="cm-legend-row">
                    <div className="cm-legend-label">
                      <span className="cm-legend-dot" style={{ background: "#008060" }} />
                      <span>Shipping address</span>
                    </div>
                    <span className="cm-legend-val">
                      {breakdownType === "count" ? breakdownData.address.count : `${breakdownData.address.percentage}%`}
                    </span>
                  </div>

                  <div className="cm-legend-row">
                    <div className="cm-legend-label">
                      <span className="cm-legend-dot" style={{ background: "#2563eb" }} />
                      <span>Items &amp; variants</span>
                    </div>
                    <span className="cm-legend-val">
                      {breakdownType === "count" ? breakdownData.variant.count : `${breakdownData.variant.percentage}%`}
                    </span>
                  </div>

                  <div className="cm-legend-row">
                    <div className="cm-legend-label">
                      <span className="cm-legend-dot" style={{ background: "#7c3aed" }} />
                      <span>Quantity</span>
                    </div>
                    <span className="cm-legend-val">
                      {breakdownType === "count" ? breakdownData.quantity.count : `${breakdownData.quantity.percentage}%`}
                    </span>
                  </div>

                  <div className="cm-legend-row">
                    <div className="cm-legend-label">
                      <span className="cm-legend-dot" style={{ background: "#f97316" }} />
                      <span>Cancellations</span>
                    </div>
                    <span className="cm-legend-val">
                      {breakdownType === "count" ? breakdownData.cancel.count : `${breakdownData.cancel.percentage}%`}
                    </span>
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "4px" }}>
                    <Link to="/app/order-activity" className="cm-btn-outline" style={{ fontSize: "11.5px", padding: "4px 10px" }}>
                      View all logs
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Card: Live Order Activity Table */}
          <div className="cm-activity-card">
            <div className="cm-activity-header">
              <div className="cm-chart-title">
                <span>Recent order activity</span>
                <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 400 }}>
                  ({activities.length} total events)
                </span>
              </div>

              <div style={{ display: "flex", gap: "8px" }}>
                <Link to="/app/order-activity" className="cm-btn-outline" style={{ fontSize: "12px", padding: "4px 12px" }}>
                  View order activity
                </Link>
              </div>
            </div>

            {activities.length === 0 ? (
              <div className="cm-empty-state-card">
                <svg className="cm-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                  <path d="m3.3 7 8.7 5 8.7-5" />
                  <path d="M12 22V12" />
                </svg>
                <h3 style={{ fontSize: "14px", fontWeight: 600, color: "#1e293b", margin: "4px 0" }}>No order edits yet</h3>
                <p style={{ fontSize: "12px", color: "#64748b", maxWidth: "360px", margin: "0 auto 12px" }}>
                  When customers edit their orders or when you test the edit flow, live activity logs and product details will appear here.
                </p>
              </div>
            ) : (
              <div className="cm-table-responsive">
                <table className="cm-dash-table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Customer</th>
                      <th>Action</th>
                      <th>Changes</th>
                      <th>Amount impact</th>
                      <th>Status</th>
                      <th>Date &amp; time</th>
                      <th style={{ width: "20px" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {activities.map((act) => (
                      <tr
                        key={act.id}
                        onClick={() => setSelectedActivity(act)}
                        style={{ cursor: "pointer" }}
                      >
                        <td>
                          <span className="cm-order-link">{act.orderNumber}</span>
                        </td>
                        <td style={{ fontWeight: 500, color: "#1a1a1a" }}>
                          {act.customerName}
                        </td>
                        <td>
                          <span className={`cm-pill-action cm-pill-${act.actionCategory}`}>
                            {act.actionType}
                          </span>
                        </td>
                        <td style={{ color: "#334155", maxWidth: "240px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {act.changes}
                        </td>
                        <td>
                          <span
                            className={
                              act.amountType === "positive"
                                ? "cm-impact-plus"
                                : act.amountType === "negative"
                                ? "cm-impact-minus"
                                : "cm-impact-neutral"
                            }
                          >
                            {act.amountImpact}
                          </span>
                        </td>
                        <td>
                          <span className={act.status === "Completed" ? "cm-pill-status-completed" : "cm-pill-status-refunded"}>
                            {act.status}
                          </span>
                        </td>
                        <td style={{ color: "#64748b", fontSize: "12px" }}>
                          {act.dateTime}
                        </td>
                        <td>
                          <span className="cm-row-arrow">›</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : (
        /* Setup Guide Mode */
        <>
          <div className="cm-dashboard-grid">
            {/* Left Column: Stepper */}
            <div className="cm-card">
              <h2 className="cm-card-title">Get started in 4 simple steps</h2>

              <div className="cm-stepper">
                {/* Step 1: Install */}
                <div className="cm-step-item">
                  <div className="cm-step-left">
                    <div className="cm-step-icon-circle">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </div>
                    <div className="cm-step-line" />
                  </div>

                  <div className="cm-step-right">
                    <div className="cm-step-content">
                      <div className="cm-step-header">
                        <div className="cm-step-number-title">
                          <span className="cm-step-num">1</span>
                          <span className="cm-step-title">Install CartMend</span>
                        </div>
                        <span className="cm-badge-completed">Completed</span>
                      </div>
                      <p className="cm-step-desc">
                        CartMend is connected to <strong>{shopDetails.name}</strong>.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Step 2: Configure Rules */}
                <div className="cm-step-item">
                  <div className="cm-step-left">
                    <div className="cm-step-icon-circle">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        <path d="m9 12 2 2 4-4" />
                      </svg>
                    </div>
                    <div className="cm-step-line" />
                  </div>

                  <div className="cm-step-right">
                    <div className="cm-step-content">
                      <div className="cm-step-header">
                        <div className="cm-step-number-title">
                          <span className="cm-step-num">2</span>
                          <span className="cm-step-title">Configure editing rules</span>
                        </div>
                        <span className="cm-badge-completed">Configured</span>
                      </div>
                      <p className="cm-step-desc">
                        Window: {merchantSettings.editingWindowMinutes} mins • Swaps: {merchantSettings.allowVariantChange ? "Enabled" : "Disabled"} • Quantities: {merchantSettings.allowQuantityChange ? "Enabled" : "Disabled"}
                      </p>
                    </div>
                    <Link
                      to="/app/editing-rules"
                      className="cm-btn-edit-rules"
                    >
                      Edit rules
                    </Link>
                  </div>
                </div>

                {/* Step 3: Connect Confirmation Email */}
                <div className="cm-step-item">
                  <div className="cm-step-left">
                    <div className={`cm-step-icon-circle ${isEmailSetupDone ? "completed" : ""}`}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="20" height="16" x="2" y="4" rx="2" />
                        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                      </svg>
                    </div>
                    <div className="cm-step-line" />
                  </div>

                  <div className="cm-step-right">
                    <div className="cm-step-content">
                      <div className="cm-step-header">
                        <div className="cm-step-number-title">
                          <span className="cm-step-num">3</span>
                          <span className="cm-step-title">Connect confirmation email</span>
                        </div>
                        {isEmailSetupDone ? (
                          <span className="cm-badge-completed">Complete ✓</span>
                        ) : (
                          <span className="cm-badge-inactive" style={{ background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}>
                            Not completed
                          </span>
                        )}
                      </div>
                      <p className="cm-step-desc">
                        Add "Edit your order" button to Shopify's Order Confirmation email.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const el = document.getElementById("cm-email-setup-section");
                        if (el) {
                          el.scrollIntoView({ behavior: "smooth", block: "start" });
                        }
                      }}
                      className="cm-btn-edit-rules"
                      style={{ cursor: "pointer", whiteSpace: "nowrap" }}
                    >
                      Connect email
                    </button>
                  </div>
                </div>

                {/* Step 4: Activate */}
                <div className="cm-step-item">
                  <div className="cm-step-left">
                    <div className="cm-step-icon-circle">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    </div>
                  </div>

                  <div className="cm-step-right">
                    <div className="cm-step-content">
                      <div className="cm-step-header">
                        <div className="cm-step-number-title">
                          <span className="cm-step-num">4</span>
                          <span className="cm-step-title">Activate CartMend</span>
                        </div>
                        {isActivated && <span className="cm-badge-completed">Active</span>}
                      </div>
                      <p className="cm-step-desc">
                        {isActivated
                          ? "CartMend is active. Customers can self-serve edits on eligible orders."
                          : "Enable CartMend to allow customers to edit their orders seamlessly."}
                      </p>
                    </div>
                    {isActivated ? (
                      <button
                        type="button"
                        onClick={handleToggleActivation}
                        className="cm-btn-deactivate"
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleToggleActivation}
                        className="cm-btn-primary"
                        style={{ width: "auto", padding: "7px 18px" }}
                      >
                        Activate
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: Real Recent Order from Shopify Admin */}
            <div className="cm-card">
              <h2 className="cm-card-title">Your store's recent order</h2>

              {recentOrderPreview ? (
                <div className="cm-order-card">
                  <div className="cm-order-header">
                    <span className="cm-order-num">{recentOrderPreview.name}</span>
                    <span className={`cm-order-badge ${recentOrderPreview.isEligible ? "" : "cm-badge-inactive"}`}>
                      {recentOrderPreview.eligibilityReason}
                    </span>
                  </div>

                  <div className="cm-order-details">
                    <div className="cm-order-row">
                      <span className="cm-order-label">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                          <line x1="16" y1="2" x2="16" y2="6" />
                          <line x1="8" y1="2" x2="8" y2="6" />
                          <line x1="3" y1="10" x2="21" y2="10" />
                        </svg>
                        Placed on
                      </span>
                      <span className="cm-order-val">{recentOrderPreview.placedOnFormatted}</span>
                    </div>

                    <div className="cm-order-row">
                      <span className="cm-order-label">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10" />
                          <polyline points="12 6 12 12 16 14" />
                        </svg>
                        Editing window until
                      </span>
                      <span className="cm-order-val">{recentOrderPreview.editingAvailableUntilFormatted}</span>
                    </div>

                    <div className="cm-order-row">
                      <span className="cm-order-label">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="m7.5 4.27 9 5.15" />
                          <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                          <path d="m3.3 7 8.7 5 8.7-5" />
                          <path d="M12 22V12" />
                        </svg>
                        Items in order
                      </span>
                      <span className="cm-order-val">{recentOrderPreview.itemsCount}</span>
                    </div>

                    <div style={{ borderTop: "1px solid #f1f2f3", margin: "4px 0" }} />

                    <div className="cm-order-row">
                      <span className="cm-order-label">
                        <span style={{ fontWeight: 600, fontSize: "13px", color: "#71767b" }}>{kpis.currencySymbol}</span>
                        Order total
                      </span>
                      <span className="cm-order-val cm-order-total">{recentOrderPreview.totalFormatted}</span>
                    </div>
                  </div>

                  {/* Product Thumbnails Preview */}
                  {recentOrderPreview.lineItems.length > 0 && (
                    <div style={{ margin: "10px 0", display: "flex", gap: "8px", overflowX: "auto" }}>
                      {recentOrderPreview.lineItems.slice(0, 4).map((it) => (
                        <div key={it.id} className="cm-dash-thumb" title={`${it.title} (Qty: ${it.quantity})`}>
                          {it.imageUrl ? (
                            <img src={it.imageUrl} alt={it.title} />
                          ) : (
                            <span className="cm-dash-thumb-placeholder">{it.title.slice(0, 2).toUpperCase()}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      const match = activities.find((a) => a.orderNumber === recentOrderPreview?.name || a.orderId === recentOrderPreview?.id);
                      if (match) {
                        setSelectedActivity(match);
                      } else {
                        setSelectedActivity({
                          id: "1011",
                          orderId: "1011",
                          orderNumber: "#1011",
                          customerName: "Alex Morgan",
                          customerEmail: "alex.morgan@example.com",
                          actionType: "Order placed",
                          actionCategory: "item",
                          changes: "1 item • Classic Plaid Flannel Overshirt",
                          amountImpact: "$57.00",
                          amountImpactValue: 57.0,
                          amountType: "neutral",
                          status: "Eligible for editing",
                          dateTime: "Aug 25, 2026, 8:34 PM",
                          rawDate: new Date().toISOString(),
                          shippingAddress: "742 Evergreen Terrace, Springfield, OR 97477, United States",
                          lineItems: [
                            {
                              id: "demo-item-1011",
                              title: "Classic Plaid Flannel Overshirt",
                              variantTitle: "Forest Green / M",
                              quantity: 1,
                              price: "57.00",
                              imageUrl: "https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=120&auto=format&fit=crop&q=80",
                            },
                          ],
                          changeDetails: [],
                          auditEvents: [
                            { event: "ORDER_CREATED", actor: "CUSTOMER", time: "Aug 25, 2026, 8:34 PM" },
                            { event: "EDIT_SESSION_ACTIVE", actor: "SYSTEM", time: "Aug 25, 2026, 8:34 PM" },
                          ],
                        });
                      }
                    }}
                    className="cm-btn-primary"
                    style={{
                      width: "100%",
                      marginTop: "6px",
                      textAlign: "center",
                      boxSizing: "border-box",
                      cursor: "pointer",
                    }}
                  >
                    View order details &amp; items
                  </button>
                </div>
              ) : (
                <div className="cm-empty-state-card" style={{ padding: "20px" }}>
                  <p style={{ margin: 0, fontSize: "13px", color: "#64748b" }}>No orders in store yet.</p>
                </div>
              )}

              {/* Assurance Box */}
              <div className="cm-assurance-box" style={{ marginTop: "12px", maxWidth: "100%" }}>
                <div className="cm-assurance-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <rect width="14" height="11" x="5" y="10" rx="2" />
                    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                    <path d="M12 13.5v4" />
                    <path d="M10 15.5h4" />
                  </svg>
                </div>
                <div>
                  <h3 className="cm-assurance-title">Secure. Automated. Hassle-free.</h3>
                  <p className="cm-assurance-desc">
                    CartMend checks inventory via GraphQL, verifies edit windows, and syncs order edits directly with Shopify Admin.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Dedicated Email Setup Card */}
          <div id="cm-email-setup-section" className="cm-email-setup-card">
            <div className="cm-email-header-flex">
              <div>
                <h3 className="cm-email-title">Add Edit Order to confirmation emails</h3>
                <p className="cm-email-subtitle">
                  Let customers edit their order directly from the Shopify order confirmation email.
                </p>
              </div>
              {isEmailSetupDone ? (
                <span className="cm-badge-completed">Setup marked complete ✓</span>
              ) : (
                <span className="cm-badge-inactive" style={{ background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}>
                  Email setup not completed
                </span>
              )}
            </div>

            {/* SECTION 1 — Why this matters */}
            <div className="cm-info-callout">
              <div className="cm-info-callout-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </div>
              <div>
                <h4 className="cm-info-callout-title">Give customers an easier way to edit</h4>
                <p className="cm-info-callout-text">
                  Customers can access CartMend's Edit Order page directly from their order confirmation email, giving them another way to make changes before their order is processed.
                </p>
              </div>
            </div>

            {/* SECTION 2 — Setup instructions */}
            <div className="cm-setup-flow">
              {/* Step 1 */}
              <div className="cm-setup-step">
                <div className="cm-setup-step-bubble">1</div>
                <h4 className="cm-setup-step-title">Copy the CartMend code</h4>
                <p className="cm-setup-step-desc">
                  Copy the code below. You only need to do this once for this store.
                </p>
                <div className="cm-liquid-code-box">
                  <div className="cm-liquid-code-header">
                    <span className="cm-liquid-badge">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="16 18 22 12 16 6" />
                        <polyline points="8 6 2 12 8 18" />
                      </svg>
                      CartMend Liquid
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyCode}
                      className={`cm-liquid-copy-btn ${copiedLiquid ? "copied" : ""}`}
                      aria-label="Copy CartMend Liquid Code"
                    >
                      {copiedLiquid ? (
                        <>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          <span>Copied!</span>
                        </>
                      ) : (
                        <>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                          </svg>
                          <span>Copy code</span>
                        </>
                      )}
                    </button>
                  </div>
                  <pre className="cm-liquid-code-body">{CARTMEND_EMAIL_LIQUID}</pre>
                </div>
              </div>

              {/* Step 2 */}
              <div className="cm-setup-step">
                <div className="cm-setup-step-bubble">2</div>
                <h4 className="cm-setup-step-title">Open your Shopify Order Confirmation settings</h4>
                <p className="cm-setup-step-desc">
                  Go to Shopify Admin → Settings → Notifications → Order confirmation → Edit code.
                </p>
                <div>
                  <a
                    href={`https://${shop}/admin/settings/notifications/order_confirmation`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="cm-btn-primary"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      width: "auto",
                      padding: "8px 16px",
                      textDecoration: "none",
                    }}
                  >
                    <span>Open Shopify settings</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                </div>
              </div>

              {/* Step 3 */}
              <div className="cm-setup-step">
                <div className="cm-setup-step-bubble">3</div>
                <h4 className="cm-setup-step-title">Paste the code into your Order Confirmation email</h4>
                <div className="cm-pathway-box">
                  <span className="cm-pathway-node">Shopify Admin</span>
                  <span className="cm-pathway-arrow">→</span>
                  <span className="cm-pathway-node">Settings</span>
                  <span className="cm-pathway-arrow">→</span>
                  <span className="cm-pathway-node">Notifications</span>
                  <span className="cm-pathway-arrow">→</span>
                  <span className="cm-pathway-node">Order confirmation</span>
                  <span className="cm-pathway-arrow">→</span>
                  <span className="cm-pathway-node">Edit code</span>
                  <span className="cm-pathway-arrow">→</span>
                  <span className="cm-pathway-node">Find "View your order"</span>
                  <span className="cm-pathway-arrow">→</span>
                  <span className="cm-pathway-node">Paste CartMend code below it</span>
                  <span className="cm-pathway-arrow">→</span>
                  <span className="cm-pathway-node" style={{ background: "#f0fdf4", borderColor: "#86efac", color: "#166534" }}>Save</span>
                </div>
                <div className="cm-tip-note">
                  <strong>Tip:</strong> Keep Shopify's existing "View your order" button. Add the CartMend code below it.
                </div>
              </div>

              {/* Step 4 */}
              <div className="cm-setup-step" style={{ borderLeftColor: "transparent" }}>
                <div className="cm-setup-step-bubble">4</div>
                <h4 className="cm-setup-step-title">You're ready</h4>
                <p className="cm-setup-step-desc">
                  Your customers can now open CartMend's Edit Order page directly from their order confirmation email.
                </p>

                <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "12px" }}>
                  <label className="cm-checkbox-label">
                    <input
                      type="checkbox"
                      checked={Boolean(isEmailSetupDone)}
                      onChange={(e) => handleToggleEmailSetup(e.target.checked)}
                      style={{ width: "16px", height: "16px", cursor: "pointer", accentColor: "#008060" }}
                    />
                    <span>I've added the CartMend code to my Order Confirmation email</span>
                  </label>

                  {isEmailSetupDone && (
                    <div style={{ fontSize: "12.5px", color: "#16a34a", fontWeight: 600, display: "flex", alignItems: "center", gap: "6px" }}>
                      <span>✓ Setup marked complete</span>
                    </div>
                  )}

                  <div>
                    <a
                      href={`https://${shop}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="cm-btn-edit-rules"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        textDecoration: "none",
                        width: "auto",
                        marginTop: "2px",
                      }}
                    >
                      <span>Place a test order</span>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                    </a>
                  </div>
                </div>
              </div>
            </div>

            {/* Collapsible Troubleshooting Section */}
            <details className="cm-troubleshooting-details">
              <summary className="cm-troubleshooting-summary">Having trouble?</summary>
              <ul className="cm-troubleshooting-list">
                <li>Make sure you are editing the <strong>Order confirmation</strong> notification template in Shopify Admin.</li>
                <li>Keep Shopify's existing <strong>View your order</strong> button — paste the CartMend code right next to or below it.</li>
                <li>Paste the CartMend code below the existing order action table cell.</li>
                <li>Save the notification template after pasting.</li>
                <li>Place a test order on your storefront to verify the <strong>Edit your order</strong> button appears in the confirmation email.</li>
              </ul>
            </details>
          </div>
        </>
      )}

      {/* Date Range Modal */}
      {isDatePickerOpen && (
        <div className="cm-modal-overlay" onClick={() => setIsDatePickerOpen(false)}>
          <div className="cm-modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "380px" }}>
            <div className="cm-modal-header">
              <h2 className="cm-modal-title">Select Date Range</h2>
              <button type="button" className="cm-modal-close" onClick={() => setIsDatePickerOpen(false)}>✕</button>
            </div>
            <div className="cm-modal-body">
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {[
                  "Today",
                  "Last 7 Days",
                  "Last 30 Days",
                  "Last 90 Days",
                  "All time",
                ].map((range) => (
                  <button
                    key={range}
                    type="button"
                    onClick={() => {
                      setDateRange(range);
                      setIsDatePickerOpen(false);
                    }}
                    style={{
                      textAlign: "left",
                      padding: "10px 12px",
                      borderRadius: "6px",
                      border: "1px solid #e1e3e5",
                      background: dateRange === range ? "#e8f5e9" : "#ffffff",
                      fontWeight: dateRange === range ? 600 : 400,
                      color: "#1a1a1a",
                      cursor: "pointer",
                    }}
                  >
                    {range}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Rich Live Order Detail Modal */}
      {selectedActivity && (
        <div className="cm-modal-overlay" onClick={() => setSelectedActivity(null)}>
          <div className="cm-modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "560px" }}>
            <div className="cm-modal-header">
              <div>
                <h2 className="cm-modal-title">Order {selectedActivity.orderNumber} Details</h2>
                <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>
                  Customer: {selectedActivity.customerName} {selectedActivity.customerEmail ? `(${selectedActivity.customerEmail})` : ""} • {selectedActivity.dateTime}
                </div>
              </div>
              <button type="button" className="cm-modal-close" onClick={() => setSelectedActivity(null)}>✕</button>
            </div>

            <div className="cm-modal-body">
              {/* Status & Financial Summary Banner */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", marginBottom: "14px" }}>
                <div>
                  <span className={`cm-pill-action cm-pill-${selectedActivity.actionCategory}`} style={{ marginRight: "8px" }}>
                    {selectedActivity.actionType}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: "13px", color: "#1e293b" }}>{selectedActivity.changes}</span>
                </div>
                <span className={selectedActivity.amountType === "positive" ? "cm-impact-plus" : selectedActivity.amountType === "negative" ? "cm-impact-minus" : "cm-impact-neutral"}>
                  {selectedActivity.amountImpact}
                </span>
              </div>

              {/* Product Line Items from Shopify GraphQL */}
              <h3 style={{ fontSize: "13px", fontWeight: 700, color: "#1e293b", marginBottom: "8px" }}>
                Ordered Products ({selectedActivity.lineItems.length})
              </h3>

              {selectedActivity.lineItems.length > 0 ? (
                <div style={{ maxHeight: "180px", overflowY: "auto", marginBottom: "14px" }}>
                  {selectedActivity.lineItems.map((item) => (
                    <div key={item.id} className="cm-dash-product-row">
                      <div className="cm-dash-thumb">
                        {item.imageUrl ? (
                          <img src={item.imageUrl} alt={item.title} />
                        ) : (
                          <span className="cm-dash-thumb-placeholder">{item.title.slice(0, 2).toUpperCase()}</span>
                        )}
                      </div>
                      <div className="cm-dash-product-info">
                        <div className="cm-dash-product-title">{item.title}</div>
                        {item.variantTitle && (
                          <span className="cm-dash-variant-pill">{item.variantTitle}</span>
                        )}
                      </div>
                      <span className="cm-dash-qty-pill">Qty: {item.quantity}</span>
                      <span className="cm-dash-product-price">
                        {kpis.currencySymbol}{parseFloat(item.price).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: "12px", color: "#64748b", fontStyle: "italic", marginBottom: "14px" }}>
                  No product line items recorded for this event.
                </p>
              )}

              {/* Step-by-Step Edit Changes Log */}
              {selectedActivity.changeDetails.length > 0 && (
                <div className="cm-diff-box">
                  <h4 style={{ fontSize: "12px", fontWeight: 700, color: "#334155", margin: "0 0 6px 0" }}>
                    CartMend Edit Log
                  </h4>
                  {selectedActivity.changeDetails.map((cd, idx) => (
                    <div key={idx} className="cm-diff-row">
                      <span style={{ fontWeight: 600, color: "#475569" }}>{cd.type}</span>
                      <span className="cm-diff-tag-new">{cd.desc}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Shipping Address */}
              {selectedActivity.shippingAddress && (
                <div style={{ fontSize: "12px", color: "#475569", background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "8px 12px", marginBottom: "12px" }}>
                  <strong>Shipping Address:</strong> {selectedActivity.shippingAddress}
                </div>
              )}

              {/* Audit Timeline */}
              {selectedActivity.auditEvents.length > 0 && (
                <div style={{ marginTop: "10px" }}>
                  <h4 style={{ fontSize: "12px", fontWeight: 700, color: "#334155", margin: "0 0 6px 0" }}>
                    Security &amp; Audit Trail
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    {selectedActivity.auditEvents.map((ev, i) => (
                      <div key={i} style={{ fontSize: "11.5px", color: "#64748b", display: "flex", justifyContent: "space-between" }}>
                        <span>• {ev.event} ({ev.actor})</span>
                        <span>{ev.time}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="cm-modal-footer">
              <button
                type="button"
                className="cm-btn-primary"
                style={{ width: "auto", padding: "6px 16px" }}
                onClick={() => setSelectedActivity(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
