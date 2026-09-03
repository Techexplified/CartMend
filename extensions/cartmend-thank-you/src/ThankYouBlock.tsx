import React, { useEffect, useState } from "react";
import {
  reactExtension,
  useApi,
  useShop,
  Banner,
  BlockStack,
  InlineStack,
  Button,
  Text,
  Heading,
  Divider,
} from "@shopify/ui-extensions-react/checkout";

// Extension Targets
export default reactExtension(
  "purchase.thank-you.block.render",
  () => <ThankYouActionsComponent />
);

export const thankYouCustomerInfo = reactExtension(
  "purchase.thank-you.customer-information.render-after",
  () => <ThankYouActionsComponent />
);

export const orderStatusBlock = reactExtension(
  "customer-account.order-status.block.render",
  () => <ThankYouActionsComponent />
);

export const orderStatusCustomerInfo = reactExtension(
  "customer-account.order-status.customer-information.render-after",
  () => <ThankYouActionsComponent />
);

interface ActionState {
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

function ThankYouActionsComponent() {
  const api = useApi() as any;
  let shop: any = null;
  try {
    shop = useShop();
  } catch {
    // fallback
  }

  const shopDomain = shop?.myshopifyDomain || api?.shop?.myshopifyDomain || api?.shop?.current?.myshopifyDomain || "";

  // Subscribe to live order updates
  const [orderConfirmation, setOrderConfirmation] = useState<any>(() => api?.orderConfirmation?.current);
  const [customerOrder, setCustomerOrder] = useState<any>(() => api?.order?.current);

  useEffect(() => {
    if (api?.orderConfirmation?.subscribe) {
      const unsub = api.orderConfirmation.subscribe((val: any) => setOrderConfirmation(val));
      return () => unsub?.();
    }
  }, [api?.orderConfirmation]);

  useEffect(() => {
    if (api?.order?.subscribe) {
      const unsub = api.order.subscribe((val: any) => setCustomerOrder(val));
      return () => unsub?.();
    }
  }, [api?.order]);

  const rawOrderId =
    customerOrder?.id ||
    orderConfirmation?.order?.id ||
    api?.order?.current?.id ||
    api?.orderConfirmation?.current?.order?.id ||
    "";
  const cleanOrderId = rawOrderId ? String(rawOrderId).replace(/\D/g, "") : "";
  const orderName =
    customerOrder?.name ||
    (orderConfirmation?.number ? `#${orderConfirmation.number}` : (cleanOrderId ? `#${cleanOrderId}` : "#1001"));

  const [data, setData] = useState<ActionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelledSuccess, setCancelledSuccess] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  // Dynamic edit and reorder URLs
  const initialEditUrl = shopDomain
    ? `https://${shopDomain}/apps/cartmend/api/customer/post-purchase/edit-session?order_id=${cleanOrderId}&shop=${shopDomain}&redirect=1`
    : `/apps/cartmend/api/customer/post-purchase/edit-session?order_id=${cleanOrderId}&redirect=1`;
  const initialReorderUrl = shopDomain ? `https://${shopDomain}/checkout` : `/checkout`;

  const [editUrl, setEditUrl] = useState<string>(initialEditUrl);
  const [reorderUrl, setReorderUrl] = useState<string>(initialReorderUrl);

  const APP_BASE_URL = "https://cart-mend.vercel.app";

  /**
   * Resilient API caller that queries the direct CartMend backend first,
   * bypassing storefront password pages and app-proxy HTML interceptors.
   */
  const callPostPurchaseApi = async (
    actionPath: string,
    bodyPayload: any
  ): Promise<{ ok: boolean; data?: any; error?: string }> => {
    const urls = [
      `${APP_BASE_URL}/apps/cartmend/api/customer/post-purchase/${actionPath}`,
      `${APP_BASE_URL}/api/customer/post-purchase/${actionPath}`,
    ];
    if (shopDomain) {
      urls.push(`https://${shopDomain}/apps/cartmend/api/customer/post-purchase/${actionPath}`);
    }

    let lastError = "Unable to connect to CartMend service";

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-shopify-shop-domain": shopDomain,
          },
          body: JSON.stringify(bodyPayload),
        });

        const text = await res.text();
        if (text && (text.startsWith("{") || text.startsWith("["))) {
          const json = JSON.parse(text);
          if (res.ok && !json.error) {
            return { ok: true, data: json };
          } else {
            lastError = json.error || `HTTP ${res.status}`;
            // If the server explicitly returned an error JSON (like window closed), return it immediately
            if (res.status === 400 || res.status === 403 || res.status === 422) {
              return { ok: false, error: lastError };
            }
          }
        }
      } catch (err: any) {
        lastError = err?.message || lastError;
      }
    }

    return { ok: false, error: lastError };
  };

  // Pre-load actions, session edit token and reorder link on mount
  useEffect(() => {
    let isMounted = true;

    async function loadPostPurchaseData() {
      try {
        setError(null);
        // 1. Fetch available actions
        const actionsRes = await callPostPurchaseApi("actions", {
          shopifyOrderId: cleanOrderId || rawOrderId || "preview",
          shopDomain,
        });

        if (isMounted && actionsRes.ok && actionsRes.data?.actions) {
          setData(actionsRes.data);
          if (typeof actionsRes.data.actions.edit?.remainingSeconds === "number") {
            setRemainingSeconds(actionsRes.data.actions.edit.remainingSeconds);
          }
        }

        // 2. Pre-generate Edit Session Redirect URL
        const editRes = await callPostPurchaseApi("edit-session", {
          shopifyOrderId: cleanOrderId || rawOrderId || "preview",
          shopDomain,
        });

        if (isMounted && editRes.ok && editRes.data?.redirectUrl) {
          const finalUrl = editRes.data.redirectUrl.startsWith("http")
            ? editRes.data.redirectUrl
            : (shopDomain ? `https://${shopDomain}${editRes.data.redirectUrl}` : editRes.data.redirectUrl);
          setEditUrl(finalUrl);
        }

        // 3. Pre-generate Reorder URL
        const reorderRes = await callPostPurchaseApi("reorder", {
          shopifyOrderId: cleanOrderId || rawOrderId || "preview",
          shopDomain,
        });

        if (isMounted && reorderRes.ok && reorderRes.data?.cartUrl) {
          const finalCartUrl = reorderRes.data.cartUrl.startsWith("http")
            ? reorderRes.data.cartUrl
            : (shopDomain ? `https://${shopDomain}${reorderRes.data.cartUrl}` : reorderRes.data.cartUrl);
          setReorderUrl(finalCartUrl);
        }
      } catch (err: any) {
        if (isMounted) {
          console.warn("[CartMend Thank You] Pre-load error:", err?.message || err);
        }
      }
    }

    loadPostPurchaseData();

    return () => {
      isMounted = false;
    };
  }, [cleanOrderId, rawOrderId, shopDomain]);

  // Live countdown timer
  useEffect(() => {
    if (remainingSeconds === null || remainingSeconds <= 0) return;

    const interval = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [remainingSeconds]);

  const formatTimer = (secs: number) => {
    if (secs <= 0) return "0m 00s";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) {
      return `${h}h ${m < 10 ? "0" : ""}${m}m ${s < 10 ? "0" : ""}${s}s`;
    }
    return `${m}m ${s < 10 ? "0" : ""}${s}s`;
  };

  const handleCancelClick = async () => {
    setBusyAction("cancel");
    setError(null);
    try {
      const res = await callPostPurchaseApi("cancel", {
        shopifyOrderId: cleanOrderId || rawOrderId || "preview",
        shopDomain,
        reason: "CUSTOMER",
        refundMethod: "ORIGINAL_PAYMENT_METHOD",
        restock: true,
      });

      if (res.ok && res.data?.success) {
        setCancelledSuccess(true);
        setShowCancelConfirm(false);
      } else {
        throw new Error(res.error || res.data?.error || "Order cancellation was not processed.");
      }
    } catch (err: any) {
      console.error("[CartMend] Cancellation error:", err);
      setError(err?.message || "Failed to cancel order on Shopify. Please try again.");
      setShowCancelConfirm(false);
    } finally {
      setBusyAction(null);
    }
  };

  if (cancelledSuccess) {
    return (
      <Banner status="success" title="Order Cancelled">
        Your order has been cancelled and refunded to your original payment method.
      </Banner>
    );
  }

  // Active state (works seamlessly with live API data OR instant Customizer preview)
  const canEdit = data ? (data.actions.edit.enabled && (remainingSeconds === null || remainingSeconds > 0)) : (remainingSeconds === null || remainingSeconds > 0);
  const canReorder = data ? data.actions.reorder.enabled : true;
  const canCancel = data ? (data.actions.cancel.enabled && (remainingSeconds === null || remainingSeconds > 0)) : (remainingSeconds === null || remainingSeconds > 0);

  return (
    <BlockStack spacing="loose">
      <Divider />
      <BlockStack spacing="tight">
        <InlineStack blockAlignment="baseline" inlineAlignment="space-between">
          <Heading level={2}>Need to make changes to your order?</Heading>
          {remainingSeconds !== null && remainingSeconds > 0 && (
            <Text appearance="subdued" size="small">
              ⏱ Editing window: {formatTimer(remainingSeconds)}
            </Text>
          )}
          {remainingSeconds !== null && remainingSeconds <= 0 && (
            <Text appearance="subdued" size="small">
              ⏱ Editing window closed
            </Text>
          )}
        </InlineStack>
        <Text appearance="subdued" size="small">
          You can edit items, update shipping address, reorder items, or cancel before fulfillment starts.
        </Text>
      </BlockStack>

      {error && (
        <Banner status="critical" title="Action Error">
          {error}
        </Banner>
      )}

      {showCancelConfirm ? (
        <Banner status="warning" title="Are you sure you want to cancel this order?">
          <BlockStack spacing="tight">
            <Text>
              All items in {orderName} will be cancelled and refunded to your original payment method.
            </Text>
            <InlineStack spacing="tight">
              <Button
                kind="primary"
                loading={busyAction === "cancel"}
                onPress={handleCancelClick}
              >
                Yes, Cancel &amp; Refund Order
              </Button>
              <Button
                kind="secondary"
                disabled={busyAction === "cancel"}
                onPress={() => setShowCancelConfirm(false)}
              >
                Keep Order
              </Button>
            </InlineStack>
          </BlockStack>
        </Banner>
      ) : (
        <InlineStack spacing="base">
          {canEdit && (
            <Button
              kind="secondary"
              to={editUrl}
            >
              Edit Order
            </Button>
          )}

          {canReorder && (
            <Button
              kind="secondary"
              to={reorderUrl}
            >
              Reorder Items
            </Button>
          )}

          {canCancel && (
            <Button
              kind="secondary"
              appearance="critical"
              loading={busyAction === "cancel"}
              disabled={busyAction !== null}
              onPress={() => setShowCancelConfirm(true)}
            >
              Cancel Order
            </Button>
          )}
        </InlineStack>
      )}
      <Divider />
    </BlockStack>
  );
}
