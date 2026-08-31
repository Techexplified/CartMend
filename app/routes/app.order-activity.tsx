import { useState, useMemo } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { getOrCreateShop, getMerchantSettings } from "../services/merchant-settings.server";
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

export interface ActivityItem {
  id: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  actionType: string;
  category: "item" | "address" | "quantity" | "cancel" | "new";
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
      };
    }
  } catch (err) {
    console.error("[CartMend] Error fetching shop in order-activity:", err);
  }

  // 2. Fetch Shop and Merchant Settings from DB
  const shopRecord = await getOrCreateShop(cleanDomain);
  const merchantSettings = await getMerchantSettings(cleanDomain);

  // 3. Fetch live orders from Shopify Admin GraphQL API
  let shopifyOrders: any[] = [];
  try {
    const ordersResponse = await admin.graphql(GET_ORDERS_QUERY, {
      variables: { first: 50 },
    });
    const ordersJson = (await ordersResponse.json()) as any;
    if (ordersJson?.data?.orders?.edges) {
      shopifyOrders = ordersJson.data.orders.edges.map((e: any) => e.node);
    }
  } catch (err) {
    console.error("[CartMend] Error querying orders from Shopify GraphQL API:", err);
  }

  // 4. Fetch CartMend database records: OrderEditSessions & OrderActivity
  const editSessions = await prisma.orderEditSession.findMany({
    where: { shopId: shopRecord.id },
    include: {
      order: true,
      changes: true,
      events: { orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const dbActivities = await prisma.orderActivity.findMany({
    where: { shop: cleanDomain },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  // 5. Build lookup map of Shopify order details
  const shopifyOrderMap = new Map<string, any>();
  for (const o of shopifyOrders) {
    const rawId = o.id ? o.id.replace("gid://shopify/Order/", "") : "";
    if (o.name) shopifyOrderMap.set(o.name, o);
    if (rawId) shopifyOrderMap.set(rawId, o);
    if (o.id) shopifyOrderMap.set(o.id, o);
  }

  // 6. Build unified real ActivityItems
  const activities: ActivityItem[] = [];

  // Add from editSessions
  for (const s of editSessions) {
    const rawOrderId = s.order?.shopifyOrderId || "";
    const matchedShopifyOrder = shopifyOrderMap.get(s.order?.shopifyOrderName || "") || shopifyOrderMap.get(rawOrderId);

    let category: ActivityItem["category"] = "item";
    let actionType = "Order edit";
    const changeDetails: Array<{ type: string; desc: string }> = [];

    for (const ch of s.changes) {
      if (ch.changeType === ChangeType.CHANGE_ADDRESS) {
        category = "address";
        actionType = "Address changed";
        changeDetails.push({ type: "Shipping Address", desc: "Customer updated shipping address" });
      } else if (ch.changeType === ChangeType.CHANGE_VARIANT) {
        category = "item";
        actionType = "Item changed";
        changeDetails.push({
          type: "Variant Swap",
          desc: `Swapped variant (Qty: ${ch.newQuantity || 1})`,
        });
      } else if (ch.changeType === ChangeType.ADD_PRODUCT) {
        category = "item";
        actionType = "Item added";
        changeDetails.push({
          type: "Product Added",
          desc: `Added variant (Qty: ${ch.newQuantity || 1})`,
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

    const extractedLineItems: ActivityItem["lineItems"] = [];
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

    activities.push({
      id: s.id,
      orderId: s.order?.shopifyOrderId || s.id,
      orderNumber: s.order?.shopifyOrderName || `#${s.id.slice(0, 6)}`,
      customerName: matchedShopifyOrder?.customer?.displayName || (matchedShopifyOrder?.customer?.firstName ? `${matchedShopifyOrder.customer.firstName} ${matchedShopifyOrder.customer.lastName || ""}`.trim() : s.order?.customerEmail ? s.order.customerEmail.split("@")[0] : "Customer"),
      customerEmail: s.order?.customerEmail || matchedShopifyOrder?.email || "",
      actionType,
      category,
      changes: changeDetails.length > 0 ? changeDetails.map((c) => c.desc).join(", ") : s.status === EditSessionStatus.CANCELLED ? "Full order cancellation" : "Order edit completed",
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

  // Add from dbActivities
  for (const act of dbActivities) {
    if (!activities.some((u) => u.orderNumber === act.orderNumber || u.orderId === act.orderId)) {
      const matchedShopifyOrder = shopifyOrderMap.get(act.orderNumber) || shopifyOrderMap.get(act.orderId);
      const diff = act.previousTotal !== null && act.newTotal !== null && act.previousTotal !== undefined && act.newTotal !== undefined && act.previousTotal > 0 ? Math.round((act.newTotal - act.previousTotal) * 100) / 100 : 0;
      const currencySym = getCurrencySymbol(shopDetails.currencyCode);
      const amountImpact = diff > 0 ? `+${currencySym}${diff.toFixed(2)}` : diff < 0 ? `-${currencySym}${Math.abs(diff).toFixed(2)}` : "—";
      const amountType: "positive" | "negative" | "neutral" = diff > 0 ? "positive" : diff < 0 ? "negative" : "neutral";

      let cat: ActivityItem["category"] = "item";
      const t = act.actionType.toLowerCase();
      if (t.includes("address")) cat = "address";
      else if (t.includes("quantity")) cat = "quantity";
      else if (t.includes("cancel")) cat = "cancel";

      const extractedLineItems: ActivityItem["lineItems"] = [];
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

      activities.push({
        id: act.id,
        orderId: act.orderId,
        orderNumber: act.orderNumber,
        customerName: act.customerName || (matchedShopifyOrder?.customer?.displayName || "Customer"),
        customerEmail: act.customerEmail || matchedShopifyOrder?.email || "",
        actionType: act.actionType,
        category: cat,
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

  // Also include recent Shopify orders so store activity is never empty
  for (const o of shopifyOrders) {
    const rawId = o.id.replace("gid://shopify/Order/", "");
    if (!activities.some((u) => u.orderNumber === o.name || u.orderId === rawId)) {
      const extractedLineItems: ActivityItem["lineItems"] = [];
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

      activities.push({
        id: `shopify-${rawId}`,
        orderId: rawId,
        orderNumber: o.name,
        customerName: o.customer?.displayName || (o.customer?.firstName ? `${o.customer.firstName} ${o.customer.lastName || ""}`.trim() : "Customer"),
        customerEmail: o.email || o.customer?.email || "",
        actionType: isCancelled ? "Order cancelled" : "Order placed",
        category: isCancelled ? "cancel" : "new",
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

  // Sort newest first
  activities.sort((a, b) => new Date(b.rawDate).getTime() - new Date(a.rawDate).getTime());

  // Compute 5 KPI summary values
  const totalActionsCount = activities.length;
  const editsCount = activities.filter((a) => a.category === "item" || a.category === "address" || a.category === "quantity").length;
  const cancellationsCount = activities.filter((a) => a.category === "cancel").length;

  let additionalPaymentsTotal = 0;
  let refundsTotal = 0;

  for (const act of activities) {
    if (act.amountImpactValue > 0) {
      additionalPaymentsTotal += act.amountImpactValue;
    } else if (act.amountImpactValue < 0) {
      refundsTotal += Math.abs(act.amountImpactValue);
    }
  }

  return {
    shop: cleanDomain,
    shopDetails,
    currencySymbol: getCurrencySymbol(shopDetails.currencyCode),
    activities,
    kpis: {
      totalActions: totalActionsCount,
      edits: editsCount,
      cancellations: cancellationsCount,
      additionalPayments: additionalPaymentsTotal,
      refunds: refundsTotal,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const shop = session.shop.replace(/^https?:\/\//, "").replace(/\/$/, "");

  if (intent === "clear_logs") {
    await prisma.orderActivity.deleteMany({
      where: { shop },
    });
    return { success: true, message: "Custom activity logs cleared." };
  }

  return null;
};

export default function OrderActivity() {
  const { shopDetails, currencySymbol, activities, kpis } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [activeCategory, setActiveCategory] = useState<"All" | "Edits" | "Cancellations" | "Additional payments" | "Refunds">("All");
  const [searchTerm, setSearchTerm] = useState("");
  const [dateRange, setDateRange] = useState("All time");
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const [isFilterModalOpen, setIsFilterModalOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [selectedOrder, setSelectedOrder] = useState<ActivityItem | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;

  const filteredData = useMemo(() => {
    return activities.filter((item) => {
      // Category filter
      let matchesCategory = true;
      if (activeCategory === "Edits") {
        matchesCategory = item.category === "item" || item.category === "address" || item.category === "quantity";
      } else if (activeCategory === "Cancellations") {
        matchesCategory = item.category === "cancel";
      } else if (activeCategory === "Additional payments") {
        matchesCategory = item.amountType === "positive";
      } else if (activeCategory === "Refunds") {
        matchesCategory = item.amountType === "negative" || item.status === "Refunded" || item.status === "Cancelled";
      }

      // Status filter
      let matchesStatus = true;
      if (statusFilter !== "ALL") {
        matchesStatus = item.status.toLowerCase() === statusFilter.toLowerCase();
      }

      // Date Range Filter
      let matchesDate = true;
      const itemTime = new Date(item.rawDate).getTime();
      const now = Date.now();
      if (dateRange === "Today") {
        matchesDate = now - itemTime <= 24 * 60 * 60 * 1000;
      } else if (dateRange === "Last 7 Days") {
        matchesDate = now - itemTime <= 7 * 24 * 60 * 60 * 1000;
      } else if (dateRange === "Last 30 Days") {
        matchesDate = now - itemTime <= 30 * 24 * 60 * 60 * 1000;
      } else if (dateRange === "Last 90 Days") {
        matchesDate = now - itemTime <= 90 * 24 * 60 * 60 * 1000;
      }

      // Search filter
      const q = searchTerm.toLowerCase();
      const matchesSearch =
        !searchTerm ||
        item.orderNumber.toLowerCase().includes(q) ||
        item.customerName.toLowerCase().includes(q) ||
        item.customerEmail.toLowerCase().includes(q) ||
        item.changes.toLowerCase().includes(q) ||
        item.lineItems.some((it) => it.title.toLowerCase().includes(q));

      return matchesCategory && matchesStatus && matchesDate && matchesSearch;
    });
  }, [activities, activeCategory, statusFilter, dateRange, searchTerm]);

  const totalPages = Math.max(Math.ceil(filteredData.length / pageSize), 1);
  const paginatedData = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredData.slice(start, start + pageSize);
  }, [filteredData, currentPage, pageSize]);

  const handleExportCSV = () => {
    if (filteredData.length === 0) {
      shopify.toast.show("No records available to export.");
      return;
    }
    const headers = "Order,Customer,Email,Action,Changes,Amount Impact,Status,Date & Time\n";
    const rows = filteredData
      .map(
        (r) =>
          `"${r.orderNumber}","${r.customerName}","${r.customerEmail}","${r.actionType}","${r.changes.replace(/"/g, '""')}","${r.amountImpact}","${r.status}","${r.dateTime}"`
      )
      .join("\n");
    const blob = new Blob([headers + rows], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `cartmend_order_activity_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    shopify.toast.show(`Exported ${filteredData.length} records to CSV.`);
  };

  return (
    <div className="cartmend-container">
      {/* Top Header */}
      <div className="cm-rules-header" style={{ marginBottom: "12px" }}>
        <div>
          <h1 className="cm-title" style={{ margin: 0 }}>Order Activity</h1>
          <p className="cm-subtitle" style={{ marginTop: "2px" }}>
            Live audit log of all customer edits, product swaps, address updates and order actions for {shopDetails.name}.
          </p>
        </div>

        <div className="cm-rules-header-actions">
          <button
            type="button"
            className="cm-btn-secondary"
            onClick={handleExportCSV}
            style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12.5px", padding: "6px 12px" }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: "14px", height: "14px" }}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            Export
          </button>
          <button
            type="button"
            className="cm-btn-secondary"
            onClick={() => setIsFilterModalOpen(true)}
            style={{ padding: "6px 10px", fontSize: "12.5px" }}
          >
            •••
          </button>
        </div>
      </div>

      {/* Filter Tabs & Search Bar */}
      <div className="cm-filter-bar">
        {/* Left Category Filter Pills */}
        <div className="cm-category-pills">
          {(["All", "Edits", "Cancellations", "Additional payments", "Refunds"] as const).map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => {
                setActiveCategory(cat);
                setCurrentPage(1);
              }}
              className={`cm-category-pill ${activeCategory === cat ? "active" : ""}`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Right Action Controls: Date Range, Filters, Search */}
        <div className="cm-filter-bar-right">
          {/* Date Picker Button */}
          <button
            type="button"
            className="cm-date-btn"
            style={{ padding: "5px 10px", fontSize: "12px" }}
            onClick={() => setIsDatePickerOpen(true)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "13px", height: "13px" }}>
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <span>{dateRange}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "11px", height: "11px" }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {/* Filters Button */}
          <button
            type="button"
            className="cm-btn-secondary"
            style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", padding: "5px 10px" }}
            onClick={() => setIsFilterModalOpen(true)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "13px", height: "13px" }}>
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
            Filters
          </button>

          {/* Search Input */}
          <div className="cm-search-input-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search orders, items, customers..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
              className="cm-input"
            />
          </div>
        </div>
      </div>

      {/* 5-Column Real KPI Metric Cards Grid */}
      <div className="cm-activity-metrics-grid">
        {/* Card 1: Total actions */}
        <div className="cm-metric-card-activity">
          <div className="cm-metric-icon square-green">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
          </div>
          <div>
            <div className="cm-metric-label">Total actions</div>
            <div className="cm-metric-value" style={{ fontSize: "19px" }}>{kpis.totalActions}</div>
            <div className="cm-metric-trend up" style={{ fontSize: "11px" }}>
              <span>Live events</span>
            </div>
          </div>
        </div>

        {/* Card 2: Edits */}
        <div className="cm-metric-card-activity">
          <div className="cm-metric-icon square-purple">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
            </svg>
          </div>
          <div>
            <div className="cm-metric-label">Edits</div>
            <div className="cm-metric-value" style={{ fontSize: "19px" }}>{kpis.edits}</div>
            <div className="cm-metric-trend up" style={{ fontSize: "11px" }}>
              <span>Self-served</span>
            </div>
          </div>
        </div>

        {/* Card 3: Cancellations */}
        <div className="cm-metric-card-activity">
          <div className="cm-metric-icon square-orange">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="9" y1="13" x2="15" y2="13" />
            </svg>
          </div>
          <div>
            <div className="cm-metric-label">Cancellations</div>
            <div className="cm-metric-value" style={{ fontSize: "19px" }}>{kpis.cancellations}</div>
            <div className="cm-metric-trend up" style={{ fontSize: "11px" }}>
              <span>Synced</span>
            </div>
          </div>
        </div>

        {/* Card 4: Additional payments */}
        <div className="cm-metric-card-activity">
          <div className="cm-metric-icon square-blue">
            <span style={{ fontWeight: 700, fontSize: "16px" }}>{currencySymbol}</span>
          </div>
          <div>
            <div className="cm-metric-label">Additional payments</div>
            <div className="cm-metric-value" style={{ fontSize: "19px" }}>
              {currencySymbol}{kpis.additionalPayments.toFixed(2)}
            </div>
            <div className="cm-metric-trend up" style={{ fontSize: "11px" }}>
              <span>Upgrades</span>
            </div>
          </div>
        </div>

        {/* Card 5: Refunds */}
        <div className="cm-metric-card-activity">
          <div className="cm-metric-icon square-red">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </div>
          <div>
            <div className="cm-metric-label">Refunds</div>
            <div className="cm-metric-value" style={{ fontSize: "19px" }}>
              {currencySymbol}{kpis.refunds.toFixed(2)}
            </div>
            <div className="cm-metric-trend down" style={{ fontSize: "11px" }}>
              <span>Reductions</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Order Activity Table Card */}
      <div className="cm-card" style={{ padding: 0, overflow: "hidden" }}>
        {paginatedData.length === 0 ? (
          <div className="cm-empty-state-card">
            <svg className="cm-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
              <path d="m3.3 7 8.7 5 8.7-5" />
              <path d="M12 22V12" />
            </svg>
            <h3 style={{ fontSize: "14px", fontWeight: 600, color: "#1e293b", margin: "4px 0" }}>No matching activity found</h3>
            <p style={{ fontSize: "12px", color: "#64748b", maxWidth: "360px", margin: "0 auto 12px" }}>
              {searchTerm || activeCategory !== "All" || statusFilter !== "ALL"
                ? "Try clearing or changing your search filters to view order activity."
                : "Live customer edits and order activity logs will appear here automatically."}
            </p>
          </div>
        ) : (
          <div className="cm-table-responsive">
            <table className="cm-dash-table">
              <thead>
                <tr style={{ background: "#ffffff" }}>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Action</th>
                  <th>Changes</th>
                  <th>Amount impact</th>
                  <th>Status</th>
                  <th>Date &amp; time</th>
                  <th style={{ width: "24px" }} />
                </tr>
              </thead>
              <tbody>
                {paginatedData.map((act) => (
                  <tr
                    key={act.id}
                    onClick={() => setSelectedOrder(act)}
                    style={{ cursor: "pointer" }}
                  >
                    <td>
                      <span className="cm-order-link">{act.orderNumber}</span>
                    </td>
                    <td style={{ fontWeight: 500, color: "#1a1a1a" }}>
                      {act.customerName}
                    </td>
                    <td>
                      <span className={`cm-pill-action cm-pill-${act.category}`}>
                        {act.actionType}
                      </span>
                    </td>
                    <td style={{ color: "#334155", maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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

        {/* Pagination Footer */}
        {filteredData.length > 0 && (
          <div className="cm-table-footer">
            <div>
              Showing {Math.min((currentPage - 1) * pageSize + 1, filteredData.length)} to {Math.min(currentPage * pageSize, filteredData.length)} of {filteredData.length} results
            </div>

            {totalPages > 1 && (
              <div className="cm-pagination">
                <button
                  type="button"
                  className={`cm-page-btn ${currentPage === 1 ? "disabled" : ""}`}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  ‹
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).slice(0, 5).map((page) => (
                  <button
                    key={page}
                    type="button"
                    className={`cm-page-btn ${currentPage === page ? "active" : ""}`}
                    onClick={() => setCurrentPage(page)}
                  >
                    {page}
                  </button>
                ))}
                {totalPages > 5 && <span className="cm-page-ellipsis">...</span>}
                <button
                  type="button"
                  className={`cm-page-btn ${currentPage === totalPages ? "disabled" : ""}`}
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  ›
                </button>
              </div>
            )}
          </div>
        )}
      </div>

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
                      setCurrentPage(1);
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

      {/* Filter Modal */}
      {isFilterModalOpen && (
        <div className="cm-modal-overlay" onClick={() => setIsFilterModalOpen(false)}>
          <div className="cm-modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "420px" }}>
            <div className="cm-modal-header">
              <h2 className="cm-modal-title">Filter Order Activity</h2>
              <button type="button" className="cm-modal-close" onClick={() => setIsFilterModalOpen(false)}>✕</button>
            </div>
            <div className="cm-modal-body">
              <div className="cm-form-group">
                <label className="cm-label">Action Category</label>
                <select
                  value={activeCategory}
                  onChange={(e) => {
                    setActiveCategory(e.target.value as any);
                    setCurrentPage(1);
                  }}
                  className="cm-select"
                >
                  <option value="All">All Actions</option>
                  <option value="Edits">Edits (Address, Item, Quantity)</option>
                  <option value="Cancellations">Cancellations</option>
                  <option value="Additional payments">Additional Payments</option>
                  <option value="Refunds">Refunds</option>
                </select>
              </div>

              <div className="cm-form-group">
                <label className="cm-label">Status</label>
                <select
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="cm-select"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="Completed">Completed</option>
                  <option value="Refunded">Refunded</option>
                  <option value="Cancelled">Cancelled</option>
                  <option value="In Progress">In Progress</option>
                </select>
              </div>
            </div>
            <div className="cm-modal-footer">
              <button
                type="button"
                className="cm-btn-secondary"
                onClick={() => {
                  setActiveCategory("All");
                  setStatusFilter("ALL");
                  setDateRange("All time");
                  setSearchTerm("");
                  setCurrentPage(1);
                  setIsFilterModalOpen(false);
                }}
              >
                Reset
              </button>
              <button
                type="button"
                className="cm-btn-primary"
                style={{ width: "auto", padding: "6px 16px" }}
                onClick={() => setIsFilterModalOpen(false)}
              >
                Apply Filters
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rich Order Detail Modal */}
      {selectedOrder && (
        <div className="cm-modal-overlay" onClick={() => setSelectedOrder(null)}>
          <div className="cm-modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "560px" }}>
            <div className="cm-modal-header">
              <div>
                <h2 className="cm-modal-title">Order {selectedOrder.orderNumber} Activity</h2>
                <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>
                  Customer: {selectedOrder.customerName} {selectedOrder.customerEmail ? `(${selectedOrder.customerEmail})` : ""} • {selectedOrder.dateTime}
                </div>
              </div>
              <button type="button" className="cm-modal-close" onClick={() => setSelectedOrder(null)}>✕</button>
            </div>

            <div className="cm-modal-body">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", marginBottom: "14px" }}>
                <div>
                  <span className={`cm-pill-action cm-pill-${selectedOrder.category}`} style={{ marginRight: "8px" }}>
                    {selectedOrder.actionType}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: "13px", color: "#1e293b" }}>{selectedOrder.changes}</span>
                </div>
                <span className={selectedOrder.amountType === "positive" ? "cm-impact-plus" : selectedOrder.amountType === "negative" ? "cm-impact-minus" : "cm-impact-neutral"}>
                  {selectedOrder.amountImpact}
                </span>
              </div>

              {/* Product Line Items from Shopify GraphQL */}
              <h3 style={{ fontSize: "13px", fontWeight: 700, color: "#1e293b", marginBottom: "8px" }}>
                Ordered Products ({selectedOrder.lineItems.length})
              </h3>

              {selectedOrder.lineItems.length > 0 ? (
                <div style={{ maxHeight: "180px", overflowY: "auto", marginBottom: "14px" }}>
                  {selectedOrder.lineItems.map((item) => (
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
                        {currencySymbol}{parseFloat(item.price).toFixed(2)}
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
              {selectedOrder.changeDetails.length > 0 && (
                <div className="cm-diff-box">
                  <h4 style={{ fontSize: "12px", fontWeight: 700, color: "#334155", margin: "0 0 6px 0" }}>
                    CartMend Edit Log
                  </h4>
                  {selectedOrder.changeDetails.map((cd, idx) => (
                    <div key={idx} className="cm-diff-row">
                      <span style={{ fontWeight: 600, color: "#475569" }}>{cd.type}</span>
                      <span className="cm-diff-tag-new">{cd.desc}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Shipping Address */}
              {selectedOrder.shippingAddress && (
                <div style={{ fontSize: "12px", color: "#475569", background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "8px 12px", marginBottom: "12px" }}>
                  <strong>Shipping Address:</strong> {selectedOrder.shippingAddress}
                </div>
              )}

              {/* Audit Timeline */}
              {selectedOrder.auditEvents.length > 0 && (
                <div style={{ marginTop: "10px" }}>
                  <h4 style={{ fontSize: "12px", fontWeight: 700, color: "#334155", margin: "0 0 6px 0" }}>
                    Security &amp; Audit Trail
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    {selectedOrder.auditEvents.map((ev, i) => (
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
                onClick={() => setSelectedOrder(null)}
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
