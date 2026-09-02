import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { getEditableOrderDetails, commitOrderEdit } from "../services/order-edit.server";
import { verifyAppProxyHmac } from "../services/crypto.server";
import { DomainError } from "../services/errors";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, X-Requested-With",
};

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const token = params.token;
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host;
  let appOrigin = url.origin;

  if (process.env.SHOPIFY_APP_URL) {
    appOrigin = process.env.SHOPIFY_APP_URL.replace(/\/$/, "");
  } else if (host && !host.includes("localhost") && !host.includes("127.0.0.1")) {
    appOrigin = `https://${host}`;
  } else if (appOrigin.startsWith("http://") && !appOrigin.includes("localhost") && !appOrigin.includes("127.0.0.1")) {
    appOrigin = appOrigin.replace("http://", "https://");
  }

  // Handle Shopify storefront section subrequests gracefully (e.g. ?section_id=...)
  if (url.searchParams.has("section_id")) {
    return new Response("", {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...CORS_HEADERS,
      },
    });
  }

  // If signature parameter is present, verify Shopify App Proxy HMAC
  const signature = url.searchParams.get("signature");
  if (signature && process.env.SHOPIFY_API_SECRET && token !== "preview") {
    const isValidProxy = verifyAppProxyHmac(url.searchParams, process.env.SHOPIFY_API_SECRET);
    if (!isValidProxy) {
      console.warn("[CartMend App Proxy] HMAC verification failed for query:", url.search);
    }
  }

  let effectiveToken = token;
  if (!effectiveToken || effectiveToken === "latest") {
    effectiveToken = "preview";
  }

  const shopDomain = request.headers.get("x-shopify-shop-domain") || url.searchParams.get("shop") || "";

  try {
    const data = await getEditableOrderDetails(effectiveToken, shopDomain);

    if (request.headers.get("accept")?.includes("application/json") || url.searchParams.get("format") === "json") {
      return Response.json(data, { headers: CORS_HEADERS });
    }

    const isPaymentReturn = url.searchParams.get("payment_return") === "1";
    const html = renderStorefrontHtml(data, effectiveToken, appOrigin, isPaymentReturn);
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "application/liquid; charset=utf-8",
        ...CORS_HEADERS,
      },
    });
  } catch (error: any) {
    console.error("[CartMend App Proxy Edit Loader Error]:", error);
    if (request.headers.get("accept")?.includes("application/json") || url.searchParams.get("format") === "json") {
      return Response.json(
        { error: error.message, code: error.name },
        { status: error instanceof DomainError ? error.statusCode : 400, headers: CORS_HEADERS }
      );
    }

    const errorHtml = renderErrorHtml(error.message || "Unable to load order editing session.");
    return new Response(errorHtml, {
      status: 200,
      headers: {
        "Content-Type": "application/liquid; charset=utf-8",
        ...CORS_HEADERS,
      },
    });
  }
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  const token = params.token;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!token) {
    return Response.json({ error: "Missing customer edit token" }, { status: 400, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: CORS_HEADERS });
  }

  try {
    let body: any = {};
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      body = await request.json().catch(() => ({}));
    } else if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const payloadStr = formData.get("payload");
      if (typeof payloadStr === "string") {
        body = JSON.parse(payloadStr);
      }
    } else {
      const text = await request.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }

    const result = await commitOrderEdit(token, body);
    return Response.json(result, { headers: CORS_HEADERS });
  } catch (error: any) {
    if (error instanceof DomainError) {
      return Response.json(
        { error: error.message, code: error.name },
        { status: error.statusCode, headers: CORS_HEADERS }
      );
    }

    console.error("[CartMend Order Commit Action Error]:", error);

    return Response.json(
      { error: "We were unable to save your changes right now. Please try again or contact store support." },
      { status: 500, headers: CORS_HEADERS }
    );
  }
};

function sanitizeCustomerMessage(msg: string): { title: string; desc: string } {
  if (!msg || typeof msg !== "string") {
    return {
      title: "Unable to Load Order",
      desc: "We were unable to load your order details right now. Please try again or contact store support for assistance.",
    };
  }

  const lower = msg.toLowerCase();
  if (lower.includes("window has expired") || lower.includes("window closed") || lower.includes("editing window")) {
    return {
      title: "Order Editing Window Closed",
      desc: "The editing window for this order has expired. If you need any assistance, please contact store customer support.",
    };
  }
  if (lower.includes("session was not found") || lower.includes("session not found") || lower.includes("not found")) {
    return {
      title: "Order Edit Session Not Found",
      desc: "We couldn't locate this order editing session. Please check the link from your confirmation email or contact store support.",
    };
  }
  if (lower.includes("already completed")) {
    return {
      title: "Order Edits Already Completed",
      desc: "Your changes for this order have already been confirmed and processed.",
    };
  }
  if (lower.includes("fulfilled") || lower.includes("partially_fulfilled")) {
    return {
      title: "Order Already Fulfilled",
      desc: "This order has already been fulfilled and can no longer be modified.",
    };
  }
  if (lower.includes("cancelled") || lower.includes("canceled")) {
    return {
      title: "Order Already Cancelled",
      desc: "This order has been cancelled and cannot be edited.",
    };
  }
  if (lower.includes("permission") || lower.includes("disabled by merchant")) {
    return {
      title: "Editing Not Permitted",
      desc: "Order editing is currently disabled or not permitted for this order.",
    };
  }

  return {
    title: "Unable to Load Order",
    desc: "We encountered an issue loading your order details. Please refresh the page or contact the store for assistance.",
  };
}

function renderErrorHtml(message: string): string {
  const { title, desc } = sanitizeCustomerMessage(message);
  return `{% layout none %}
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${title} | CartMend</title>
      </head>
      <body style="margin: 0; background: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
        <div style="max-width: 560px; margin: 60px auto; padding: 32px 24px; text-align: center; background-color: #fff; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); border: 1px solid #fee2e2;">
          <div style="width: 56px; height: 56px; border-radius: 50%; background-color: #fee2e2; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px; color: #dc2626; font-size: 28px;">
            ⚠️
          </div>
          <h2 style="color: #111827; font-size: 22px; font-weight: 700; margin: 0 0 8px 0;">${title}</h2>
          <p style="color: #6b7280; font-size: 15px; line-height: 1.5; margin: 0 0 24px 0;">${desc}</p>
          <a href="/" style="display: inline-block; background-color: #111827; color: #fff; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
            Return to Storefront
          </a>
        </div>
      </body>
    </html>
  `;
}

function renderStorefrontHtml(data: any, token: string, appOrigin: string, isPaymentReturn = false): string {
  const session = data?.session || {};
  const order = data?.order || {};
  const permissions = data?.permissions || {};
  const rawItems = Array.isArray(data?.items)
    ? data.items
    : (Array.isArray(data?.order?.lineItems) ? data.order.lineItems : []);

  const initialFirstName = (order.shippingAddress?.firstName || "").trim();
  const initialLastName = (order.shippingAddress?.lastName || "").trim();
  const initialFullName = `${initialFirstName} ${initialLastName}`.trim() || order.shippingAddress?.name || (initialFirstName || "Customer");
  const address1 = order.shippingAddress?.address1 || "";
  const address2 = order.shippingAddress?.address2 || "";
  const city = order.shippingAddress?.city || "";
  const province = order.shippingAddress?.province || "";
  const zip = order.shippingAddress?.zip || "";
  const phone = order.shippingAddress?.phone || "";
  const country = order.shippingAddress?.country || "United States";
  const currency = order.currency || "USD";
  const orderTotal = Number(order.total || 0);

  const createdDate = order.createdAt ? new Date(order.createdAt) : new Date();
  const formattedDate = createdDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const formattedTime = createdDate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

  const remainingSeconds = session.remainingSeconds !== undefined
    ? Number(session.remainingSeconds)
    : (session.expiresAt ? Math.max(0, Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000)) : 1800);
  const initialHours = Math.floor(remainingSeconds / 3600);
  const initialMins = Math.floor((remainingSeconds % 3600) / 60);
  const initialSecs = remainingSeconds % 60;
  const initialTimerStr = remainingSeconds <= 0
    ? "00m : 00s"
    : `${initialHours > 0 ? (initialHours < 10 ? "0" : "") + initialHours + "h " : ""}${initialMins < 10 ? "0" : ""}${initialMins}m : ${initialSecs < 10 ? "0" : ""}${initialSecs}s`;

  const canAddress = permissions.address !== false;
  const canVariant = permissions.variant !== false;
  const canQuantity = permissions.quantity !== false;
  const canCancel = permissions.removeProduct !== false && permissions.cancellation !== false && permissions.allowOrderCancellation !== false;

  let initialTab = "address";
  if (!canAddress) {
    if (canVariant) initialTab = "items";
    else if (canQuantity) initialTab = "quantity";
    else if (canCancel) initialTab = "cancel";
  }

  const items = rawItems.map((it: any) => {
    const unitPrice = typeof it.unitPrice === "number" ? it.unitPrice : parseFloat(it.unitPrice || it.price || "0");
    return {
      id: it.id || "item_1",
      title: it.title || "Order Item",
      quantity: Number(it.quantity || it.currentQuantity || 1),
      unitPrice: isNaN(unitPrice) ? 0 : unitPrice,
      variant: it.variant
        ? {
            id: it.variant.id,
            title: it.variant.title,
            price: typeof it.variant.price === "number" ? it.variant.price : parseFloat(it.variant.price || "0"),
            product: it.variant.product,
          }
        : null,
      availableVariants: (Array.isArray(it.availableVariants) ? it.availableVariants : []).map((v: any) => ({
        id: v.id,
        title: v.title,
        price: typeof v.price === "number" ? v.price : parseFloat(v.price || "0"),
      })),
    };
  });
  const storeName = (data?.shop?.name || session?.shop?.shopName || "Summer Store").trim();
  const sanitizedItems = items;

  return `{% layout none %}
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Edit Order ${order.name} | CartMend</title>
      <style>
        body { margin: 0; padding: 0; background: #f8fafc; color: #1e293b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        .cm-app-container { max-width: 1200px; margin: 0 auto; padding: 24px 24px 80px 24px; box-sizing: border-box; }
        .cm-sf-progress-header { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px 24px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
        .cm-sf-progress-steps { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .cm-sf-progress-step { display: flex; align-items: center; gap: 10px; opacity: 0.5; }
        .cm-sf-progress-step.active, .cm-sf-progress-step.completed { opacity: 1; }
        .cm-sf-progress-circle { width: 28px; height: 28px; border-radius: 50%; background: #f1f5f9; color: #64748b; font-weight: 700; font-size: 13px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .cm-sf-progress-step.active .cm-sf-progress-circle { background: #008060; color: #ffffff; }
        .cm-sf-progress-step.completed .cm-sf-progress-circle { background: #008060; color: #ffffff; }
        .cm-sf-progress-label { font-size: 13px; font-weight: 700; color: #1e293b; }
        .cm-sf-progress-sub { font-size: 11px; color: #64748b; }
        .cm-sf-progress-connector { flex: 1; height: 2px; background: #e2e8f0; margin: 0 8px; }
        .cm-sf-progress-connector.filled { background: #008060; }
        
        .cm-sf-card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); margin-bottom: 20px; }
        .cm-sf-access-grid { display: grid; grid-template-columns: 360px 1fr; gap: 24px; }
        .cm-sf-layout-grid { display: grid; grid-template-columns: 1.3fr 1fr; gap: 24px; }
        @media(max-width: 860px) { .cm-sf-access-grid, .cm-sf-layout-grid { grid-template-columns: 1fr; } }

        .cm-sf-order-header-card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px 20px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px; }
        .cm-sf-actions-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 24px; }
        .cm-sf-action-card { background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 14px 12px; text-align: center; cursor: pointer; transition: all 0.15s ease; position: relative; }
        .cm-sf-action-card:hover { border-color: #008060; background: #f0fdf4; }
        .cm-sf-action-card.active { border-color: #008060; background: #f0fdf4; box-shadow: 0 0 0 1px #008060; }
        .cm-sf-action-card.disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }
        .cm-sf-action-radio { position: absolute; top: 10px; right: 10px; width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid #cbd5e1; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 800; color: #ffffff; }
        .cm-sf-action-card.active .cm-sf-action-radio { background: #008060; border-color: #008060; }
        .cm-sf-action-icon { font-size: 24px; margin-bottom: 6px; }
        .cm-sf-action-title { font-size: 13px; font-weight: 700; margin-bottom: 2px; }
        .cm-sf-action-sub { font-size: 11px; color: #64748b; }

        .cm-sf-input-group { margin-bottom: 14px; text-align: left; }
        .cm-sf-input-group label { display: block; font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 6px; }
        .cm-sf-input-group input, .cm-select { width: 100%; padding: 9px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 13.5px; box-sizing: border-box; outline: none; transition: border-color 0.15s ease; background: #ffffff; }
        .cm-sf-input-group input:focus, .cm-select:focus { border-color: #008060; box-shadow: 0 0 0 2px rgba(0,128,96,0.15); }

        .cm-sf-qty-ctrl { display: inline-flex; align-items: center; border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; background: #ffffff; }
        .cm-sf-qty-btn { width: 32px; height: 32px; background: #f8fafc; border: none; font-size: 16px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .cm-sf-qty-btn:hover { background: #e2e8f0; }
        .cm-sf-qty-val { width: 36px; text-align: center; font-size: 13.5px; font-weight: 700; }

        .cm-btn-primary { background: #008060; color: #ffffff; border: none; border-radius: 8px; font-weight: 700; cursor: pointer; transition: all 0.15s ease; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
        .cm-btn-primary:hover { background: #006e52; }
        .cm-btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

        .cm-btn-outline { background: #ffffff; color: #1e293b; border: 1px solid #cbd5e1; border-radius: 8px; font-weight: 600; cursor: pointer; transition: all 0.15s ease; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
        .cm-btn-outline:hover { background: #f8fafc; border-color: #94a3b8; }

        .cm-badge-completed { background: #dcfce7; color: #15803d; font-size: 11.5px; font-weight: 700; padding: 3px 10px; border-radius: 12px; }
        .cm-badge-payment { background: #eff6ff; color: #1e40af; font-size: 11.5px; font-weight: 700; padding: 3px 10px; border-radius: 12px; }
        .cm-sf-timer-pill { background: #fef3c7; border: 1px solid #fde68a; border-radius: 8px; padding: 6px 12px; text-align: right; }
        .cm-sf-timer-val { font-size: 14px; font-weight: 800; color: #92400e; font-family: monospace; }
        .cm-sf-nav-bar { display: flex; justify-content: space-between; align-items: center; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; }

        /* Step 5 Done Page Specific Styles */
        .cm-done-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 24px; text-align: left; margin-top: 10px; }
        @media(max-width: 900px) { .cm-done-grid { grid-template-columns: 1fr; } }

        .cm-done-hero-card { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 24px; display: flex; align-items: flex-start; gap: 18px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.02); }
        .cm-done-hero-icon { width: 48px; height: 48px; border-radius: 50%; background: #008060; color: #ffffff; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .cm-done-title { font-size: 22px; font-weight: 800; color: #0f172a; margin: 0 0 6px 0; }
        .cm-done-sub { font-size: 14px; color: #475569; margin: 0 0 14px 0; }
        .cm-done-details-btn { background: #ffffff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 600; color: #1e293b; cursor: pointer; display: inline-flex; align-items: center; transition: all 0.15s ease; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
        .cm-done-details-btn:hover { background: #f8fafc; border-color: #94a3b8; }

        .cm-done-card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.03); margin-bottom: 20px; }
        .cm-done-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
        .cm-done-card-title { font-size: 16px; font-weight: 700; color: #0f172a; margin: 0; }

        .cm-badge-pill-green { background: #dcfce7; color: #15803d; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 12px; }
        .cm-badge-pill-updated { background: #f0fdf4; border: 1px solid #bbf7d0; color: #15803d; font-size: 11.5px; font-weight: 600; padding: 3px 10px; border-radius: 12px; }

        .cm-updated-list { display: flex; flex-direction: column; }
        .cm-updated-item { display: flex; justify-content: space-between; align-items: center; padding: 14px 0; border-bottom: 1px solid #f1f5f9; }
        .cm-updated-item:last-child { border-bottom: none; padding-bottom: 0; }
        .cm-updated-item-left { display: flex; align-items: center; gap: 14px; }
        .cm-updated-item-icon { width: 36px; height: 36px; border-radius: 50%; background: #e8f5e9; color: #008060; display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; font-weight: 700; }
        .cm-updated-item-title { font-size: 13.5px; font-weight: 700; color: #1e293b; margin-bottom: 2px; }
        .cm-updated-item-sub { font-size: 12.5px; color: #64748b; line-height: 1.4; }

        .cm-summary-flow { display: flex; align-items: center; justify-content: space-between; background: #ffffff; padding: 6px 0; }
        .cm-summary-box { text-align: left; flex: 1; }
        .cm-summary-label { font-size: 12px; color: #64748b; margin-bottom: 4px; font-weight: 500; }
        .cm-summary-val { font-size: 16px; font-weight: 700; color: #1e293b; }
        .cm-summary-delta { color: #008060; font-weight: 700; }
        .cm-summary-total { color: #0f172a; font-weight: 800; font-size: 18px; }
        .cm-summary-arrow { color: #94a3b8; font-size: 20px; padding: 0 14px; font-weight: 300; }

        .cm-done-email-banner { background: #f0f7ff; border: 1px solid #bae6fd; border-radius: 10px; padding: 14px 16px; display: flex; align-items: center; gap: 12px; margin-bottom: 20px; font-size: 13px; color: #0369a1; }
        .cm-done-email-icon { font-size: 18px; flex-shrink: 0; color: #0284c7; }

        .cm-next-steps-list { display: flex; flex-direction: column; gap: 18px; }
        .cm-next-step-item { display: flex; gap: 14px; align-items: flex-start; }
        .cm-next-step-icon { width: 34px; height: 34px; border-radius: 50%; background: #f0fdf4; border: 1px solid #bbf7d0; color: #008060; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .cm-next-step-heading { font-size: 13.5px; font-weight: 700; color: #1e293b; margin-bottom: 2px; }
        .cm-next-step-desc { font-size: 12.5px; color: #64748b; line-height: 1.4; }

        .cm-done-help-card { background: #fff5f5; border: 1px solid #fee2e2; border-radius: 12px; padding: 20px 24px; margin-bottom: 20px; }
        .cm-help-title { font-size: 15px; font-weight: 800; color: #dc2626; margin: 0 0 4px 0; }
        .cm-help-sub { font-size: 12px; color: #7f1d1d; margin: 0 0 16px 0; }
        .cm-help-items { display: flex; flex-direction: column; gap: 14px; }
        .cm-help-item { display: flex; gap: 12px; align-items: flex-start; }
        .cm-help-item-icon { font-size: 16px; flex-shrink: 0; margin-top: 1px; }
        .cm-help-item-title { font-size: 13px; font-weight: 700; color: #1e293b; margin-bottom: 2px; }
        .cm-help-item-desc { font-size: 12px; color: #64748b; margin-bottom: 3px; }
        .cm-help-link { font-size: 12px; font-weight: 600; color: #2563eb; text-decoration: underline; cursor: pointer; }

        .cm-done-bottom-nav { display: flex; justify-content: flex-start; align-items: center; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; }

        @keyframes cmSpin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .cm-spinner {
          width: 42px;
          height: 42px;
          border: 4px solid #e2e8f0;
          border-top-color: #008060;
          border-radius: 50%;
          animation: cmSpin 0.75s linear infinite;
          margin: 0 auto 16px auto;
        }
      </style>

      <div class="cm-app-container">
        <!-- Stepper Header (Steps 2 to 5) -->
        <div id="cm-stepper-header" class="cm-sf-progress-header" style="display: none;">
          <div class="cm-sf-progress-steps">
            <div id="cm-pstep-1" class="cm-sf-progress-step completed">
              <div class="cm-sf-progress-circle">✓</div>
              <div>
                <div class="cm-sf-progress-label">1. Access</div>
                <div class="cm-sf-progress-sub">Access granted</div>
              </div>
            </div>
            <div id="cm-pconn-1" class="cm-sf-progress-connector filled"></div>

            <div id="cm-pstep-2" class="cm-sf-progress-step active">
              <div class="cm-sf-progress-circle">2</div>
              <div>
                <div class="cm-sf-progress-label">2. Edit</div>
                <div class="cm-sf-progress-sub">Changes added</div>
              </div>
            </div>
            <div id="cm-pconn-2" class="cm-sf-progress-connector"></div>

            <div id="cm-pstep-3" class="cm-sf-progress-step">
              <div class="cm-sf-progress-circle">3</div>
              <div>
                <div class="cm-sf-progress-label">3. Review &amp; Impact</div>
                <div class="cm-sf-progress-sub">Changes reviewed</div>
              </div>
            </div>
            <div id="cm-pconn-3" class="cm-sf-progress-connector"></div>

            <div id="cm-pstep-4" class="cm-sf-progress-step">
              <div class="cm-sf-progress-circle">4</div>
              <div>
                <div class="cm-sf-progress-label">4. Payment / Refund</div>
                <div class="cm-sf-progress-sub">Payment completed</div>
              </div>
            </div>
            <div id="cm-pconn-4" class="cm-sf-progress-connector"></div>

            <div id="cm-pstep-5" class="cm-sf-progress-step">
              <div class="cm-sf-progress-circle">5</div>
              <div>
                <div class="cm-sf-progress-label">5. Done</div>
                <div class="cm-sf-progress-sub">Order updated</div>
              </div>
            </div>
          </div>
        </div>

        <!-- STEP 1: ACCESS YOUR ORDER -->
        <div id="cm-step-1" style="display: block;">
          <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
            <div style="display: flex; align-items: center; gap: 12px;">
              <div style="width: 26px; height: 26px; border-radius: 50%; background: #008060; color: #ffffff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px;">✓</div>
              <div>
                <div style="font-size: 14px; font-weight: 700; color: #14532d;">Great! You can make changes to this order.</div>
                <div style="font-size: 12.5px; color: #166534;">Review the details below and continue to edit eligible parts.</div>
              </div>
            </div>
            <div style="font-size: 13px; color: #15803d; display: flex; align-items: center; gap: 6px;">
              <span>💬</span> Need help?
            </div>
          </div>

          <div class="cm-sf-access-grid">
            <!-- Left: Verification Card -->
            <div class="cm-sf-card" style="height: fit-content;">
              <div style="width: 40px; height: 40px; border-radius: 50%; background: #e8f5e9; color: #008060; display: flex; align-items: center; justify-content: center; margin-bottom: 14px;">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="m9 12 2 2 4-4"></path></svg>
              </div>
              <h2 style="font-size: 18px; font-weight: 700; margin: 0 0 4px 0;">Access your order</h2>
              <p style="font-size: 13px; color: #64748b; margin: 0 0 20px 0;">Let's verify a few details to securely load your order.</p>

              <div class="cm-sf-input-group">
                <label>Order number</label>
                <div style="position: relative;">
                  <input type="text" value="${order.name}" readonly style="padding-right: 36px; font-weight: 600;" />
                  <span style="position: absolute; right: 12px; top: 10px; color: #008060; font-weight: 800;">✓</span>
                </div>
              </div>

              <div class="cm-sf-input-group">
                <label>Email address</label>
                <div style="position: relative;">
                  <input type="text" value="${order.email || "customer@example.com"}" readonly style="padding-right: 36px;" />
                  <span style="position: absolute; right: 12px; top: 10px; color: #008060; font-weight: 800;">✓</span>
                </div>
              </div>

              <button type="button" class="cm-btn-primary cm-btn-goto" data-goto="2" style="width: 100%; padding: 12px 0; margin-top: 16px; font-size: 14px;">
                View my order →
              </button>

              <div style="font-size: 11.5px; color: #64748b; margin-top: 16px; display: flex; align-items: center; gap: 8px;">
                <span>🔒</span> This link is unique to you and this order. It will not work for others.
              </div>

              <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 14px; margin-top: 20px; display: flex; gap: 10px; align-items: center;">
                <div style="color: #008060; font-size: 18px;">🛡️</div>
                <div style="font-size: 12px; color: #475569;">
                  <strong>Your information is safe.</strong> We use industry-standard encryption to keep your order information secure.
                </div>
              </div>
            </div>

            <!-- Right: Order Details Card -->
            <div class="cm-sf-card">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px;">
                <div>
                  <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 20px; font-weight: 800;">Order ${order.name}</span>
                    <span class="cm-badge-completed">Confirmed</span>
                  </div>
                  <div style="font-size: 13px; color: #64748b; margin-top: 4px;">Placed on ${formattedDate} at ${formattedTime}</div>
                </div>
                <a href="/" target="_blank" class="cm-btn-outline" style="font-size: 12.5px; padding: 6px 12px;">View in store ↗</a>
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; padding: 16px 0; border-top: 1px solid #f1f5f9; border-bottom: 1px solid #f1f5f9; font-size: 12.5px;">
                <div>
                  <div style="color: #64748b;">📅 Estimated delivery</div>
                  <div style="font-weight: 600; margin-top: 4px;">2–3 business days</div>
                </div>
                <div>
                  <div style="color: #64748b;">📍 Shipping to</div>
                  <div style="font-weight: 600; margin-top: 4px;">${initialFullName}</div>
                  <div style="font-size: 11px; color: #94a3b8;">${city ? `${city}, ${province || zip}` : "Address provided"}</div>
                </div>
                <div>
                  <div style="color: #64748b;">💳 Payment method</div>
                  <div style="font-weight: 600; margin-top: 4px;">Online / Credit Card</div>
                  <div style="font-size: 11.5px; color: #008060; font-weight: 700;">Paid ${currency} ${orderTotal.toFixed(2)}</div>
                </div>
              </div>

              <!-- Edit Window Banner -->
              <div style="background: #fef3c7; border: 1px solid #fde68a; border-radius: 10px; padding: 12px 16px; margin: 18px 0; display: flex; justify-content: space-between; align-items: center;">
                <div>
                  <div style="font-weight: 700; font-size: 13.5px; color: #92400e;">🕒 Edit window</div>
                  <div style="font-size: 12px; color: #78350f;">You can edit this order until ${session.expiresAt ? new Date(session.expiresAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "order cutoff"}.</div>
                </div>
                <div style="text-align: right; background: #ffffff; padding: 6px 12px; border-radius: 8px; border: 1px solid #fde68a;">
                  <div class="cm-timer-val" style="font-size: 14px; font-weight: 800; color: #92400e; font-family: monospace;">${initialTimerStr}</div>
                  <div style="font-size: 10px; color: #78350f;">Time remaining</div>
                </div>
              </div>

              <!-- What Can You Edit Pills -->
              <div style="margin: 20px 0;">
                <div style="font-size: 14px; font-weight: 700; margin-bottom: 10px;">What can you edit?</div>
                <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; text-align: center;">
                  <div style="padding: 10px 6px; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc;">
                    <div style="font-size: 16px;">📍</div>
                    <div style="font-size: 11.5px; font-weight: 600; margin-top: 2px;">Shipping address</div>
                    <span style="font-size: 10px; color: ${permissions.address ? "#15803d" : "#64748b"}; background: ${permissions.address ? "#dcfce7" : "#f1f5f9"}; padding: 2px 8px; border-radius: 10px; font-weight: 600; display: inline-block; margin-top: 4px;">
                      ${permissions.address ? "Allowed" : "Not allowed"}
                    </span>
                  </div>
                  <div style="padding: 10px 6px; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc;">
                    <div style="font-size: 16px;">📦</div>
                    <div style="font-size: 11.5px; font-weight: 600; margin-top: 2px;">Items & variants</div>
                    <span style="font-size: 10px; color: ${permissions.variant ? "#15803d" : "#64748b"}; background: ${permissions.variant ? "#dcfce7" : "#f1f5f9"}; padding: 2px 8px; border-radius: 10px; font-weight: 600; display: inline-block; margin-top: 4px;">
                      ${permissions.variant ? "Allowed" : "Not allowed"}
                    </span>
                  </div>
                  <div style="padding: 10px 6px; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc;">
                    <div style="font-size: 16px;">#</div>
                    <div style="font-size: 11.5px; font-weight: 600; margin-top: 2px;">Quantity</div>
                    <span style="font-size: 10px; color: ${permissions.quantity ? "#15803d" : "#64748b"}; background: ${permissions.quantity ? "#dcfce7" : "#f1f5f9"}; padding: 2px 8px; border-radius: 10px; font-weight: 600; display: inline-block; margin-top: 4px;">
                      ${permissions.quantity ? "Allowed" : "Not allowed"}
                    </span>
                  </div>
                  <div style="padding: 10px 6px; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc;">
                    <div style="font-size: 16px;">❌</div>
                    <div style="font-size: 11.5px; font-weight: 600; margin-top: 2px;">Cancel order</div>
                    <span style="font-size: 10px; color: ${canCancel ? "#15803d" : "#64748b"}; background: ${canCancel ? "#dcfce7" : "#f1f5f9"}; padding: 2px 8px; border-radius: 10px; font-weight: 600; display: inline-block; margin-top: 4px;">
                      ${canCancel ? "Allowed" : "Not allowed"}
                    </span>
                  </div>
                  <div style="padding: 10px 6px; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc; opacity: 0.7;">
                    <div style="font-size: 16px;">🔒</div>
                    <div style="font-size: 11.5px; font-weight: 600; margin-top: 2px;">Payment method</div>
                    <span style="font-size: 10px; color: #64748b; background: #f1f5f9; padding: 2px 8px; border-radius: 10px; font-weight: 600; display: inline-block; margin-top: 4px;">
                      Not allowed
                    </span>
                  </div>
                </div>
              </div>

              <!-- Order Items List -->
              <div style="border-top: 1px solid #f1f5f9; padding-top: 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                  <span style="font-size: 14px; font-weight: 700;">Order items (${items.length})</span>
                  <span style="font-size: 11.5px; color: #15803d; background: #dcfce7; padding: 2px 10px; border-radius: 12px; font-weight: 600;">Unfulfilled (Eligible)</span>
                </div>

                ${items.map((item: any) => `
                  <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #f1f5f9;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                      ${item.variant?.product?.image ? `<img src="${item.variant.product.image}" style="width: 44px; height: 44px; border-radius: 6px; object-fit: cover; border: 1px solid #e2e8f0;" />` : `<div style="width: 44px; height: 44px; border-radius: 6px; background: #e8f5e9; display: flex; align-items: center; justify-content: center; font-size: 20px;">🛍️</div>`}
                      <div>
                        <div style="font-weight: 700; font-size: 14px;">${item.title}</div>
                        <div style="font-size: 12.5px; color: #64748b;">Qty: ${item.quantity} • ${currency} ${item.unitPrice.toFixed(2)} each</div>
                      </div>
                    </div>
                    <div style="text-align: right;">
                      <div style="font-weight: 700; font-size: 14px;">${currency} ${(item.quantity * item.unitPrice).toFixed(2)}</div>
                      <span style="font-size: 11px; color: #008060; background: #f0fdf4; padding: 2px 8px; border-radius: 10px; font-weight: 600;">You can edit this item</span>
                    </div>
                  </div>
                `).join("")}
              </div>

              <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 20px; padding-top: 16px; border-top: 1px solid #f1f5f9;">
                <span style="font-size: 12.5px; color: #64748b;">ℹ️ Next, you can make changes to the eligible parts of your order.</span>
                <button type="button" class="cm-btn-primary cm-btn-goto" data-goto="2" style="padding: 10px 24px; font-size: 14px;">
                  Continue to edit order →
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- STEP 2: EDIT YOUR ORDER -->
        <div id="cm-step-2" style="display: none;">
          <div class="cm-sf-order-header-card">
            <div style="display: flex; align-items: center; gap: 12px;">
              <div style="width: 42px; height: 42px; border-radius: 8px; background: #e8f5e9; color: #008060; display: flex; align-items: center; justify-content: center; font-size: 20px;">🛍️</div>
              <div>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-size: 18px; font-weight: 800;">Order ${order.name}</span>
                  <span class="cm-badge-completed">Confirmed</span>
                </div>
                <div style="font-size: 12.5px; color: #64748b;">Placed on ${formattedDate} at ${formattedTime}</div>
              </div>
            </div>
            <div class="cm-sf-timer-pill">
              <div style="font-size: 11px; color: #78350f;">Edit window closes in</div>
              <div class="cm-sf-timer-val cm-timer-val">${initialTimerStr}</div>
            </div>
          </div>

          <div style="margin-bottom: 20px;">
            <h2 style="font-size: 20px; font-weight: 800; margin: 0 0 4px 0;">Edit your order</h2>
            <p style="font-size: 13px; color: #64748b; margin: 0;">Select what you'd like to change. Only eligible parts of your order can be edited.</p>
          </div>

          <div class="cm-sf-actions-grid">
            <div id="cm-card-address" class="cm-sf-action-card ${!canAddress ? "disabled" : (initialTab === "address" ? "active" : "")} ${canAddress ? "cm-tab-btn" : ""}" data-tab="address" ${!canAddress ? 'style="opacity:0.5;cursor:not-allowed;"' : ""}>
              <div class="cm-sf-action-radio">${canAddress && initialTab === "address" ? "✓" : ""}</div>
              <div class="cm-sf-action-icon">📍</div>
              <div class="cm-sf-action-title">Shipping address</div>
              <div class="cm-sf-action-sub">${canAddress ? "Change delivery address" : "Disabled by store"}</div>
            </div>
            <div id="cm-card-items" class="cm-sf-action-card ${!canVariant ? "disabled" : (initialTab === "items" ? "active" : "")} ${canVariant ? "cm-tab-btn" : ""}" data-tab="items" ${!canVariant ? 'style="opacity:0.5;cursor:not-allowed;"' : ""}>
              <div class="cm-sf-action-radio">${canVariant && initialTab === "items" ? "✓" : ""}</div>
              <div class="cm-sf-action-icon">📦</div>
              <div class="cm-sf-action-title">Items or variants</div>
              <div class="cm-sf-action-sub">${canVariant ? "Change size, color, variant" : "Disabled by store"}</div>
            </div>
            <div id="cm-card-quantity" class="cm-sf-action-card ${!canQuantity ? "disabled" : (initialTab === "quantity" ? "active" : "")} ${canQuantity ? "cm-tab-btn" : ""}" data-tab="quantity" ${!canQuantity ? 'style="opacity:0.5;cursor:not-allowed;"' : ""}>
              <div class="cm-sf-action-radio">${canQuantity && initialTab === "quantity" ? "✓" : ""}</div>
              <div class="cm-sf-action-icon">#</div>
              <div class="cm-sf-action-title">Quantity</div>
              <div class="cm-sf-action-sub">${canQuantity ? "Change item quantity" : "Disabled by store"}</div>
            </div>
            <div id="cm-card-cancel" class="cm-sf-action-card ${!canCancel ? "disabled" : (initialTab === "cancel" ? "active" : "")} ${canCancel ? "cm-tab-btn" : ""}" data-tab="cancel" ${!canCancel ? 'style="opacity:0.5;cursor:not-allowed;"' : ""}>
              <div class="cm-sf-action-radio">${canCancel && initialTab === "cancel" ? "✓" : ""}</div>
              <div class="cm-sf-action-icon" style="color: #dc2626;">❌</div>
              <div class="cm-sf-action-title">Cancel order</div>
              <div class="cm-sf-action-sub">${canCancel ? "Cancel entire order" : "Disabled by store"}</div>
            </div>
            <div class="cm-sf-action-card disabled" style="opacity:0.5;cursor:not-allowed;">
              <div class="cm-sf-action-icon">🔒</div>
              <div class="cm-sf-action-title">Payment method</div>
              <div class="cm-sf-action-sub">Not allowed</div>
            </div>
          </div>

          <div class="cm-sf-layout-grid">
            <!-- Left Form -->
            <div class="cm-sf-card">
              <div id="cm-panel-address" style="display: ${initialTab === "address" ? "block" : "none"};">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px;">
                  <div>
                    <h3 style="font-size: 15px; font-weight: 700; margin: 0 0 2px 0;">Update shipping address</h3>
                    <div style="font-size: 12.5px; color: #64748b;">Enter the new shipping address.</div>
                  </div>
                  <span style="font-size: 11.5px; color: #15803d; background: #dcfce7; padding: 3px 10px; border-radius: 12px; font-weight: 600;">✓ Good news!</span>
                </div>

                <div style="font-size: 12px; color: #64748b; background: #f8fafc; padding: 8px 12px; border-radius: 8px; margin-bottom: 16px;">
                  Your order is not yet fulfilled. You can update the shipping address.
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
                  <div class="cm-sf-input-group">
                    <label>First name</label>
                    <input id="cm-in-fname" type="text" value="${initialFirstName || (initialFullName.split(' ')[0] || '')}" />
                  </div>
                  <div class="cm-sf-input-group">
                    <label>Last name</label>
                    <input id="cm-in-lname" type="text" value="${initialLastName || (initialFullName.split(' ').slice(1).join(' ') || initialFirstName || 'Customer')}" />
                  </div>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 10px;">
                  <div class="cm-sf-input-group">
                    <label>Phone (optional)</label>
                    <input id="cm-in-phone" type="text" value="${phone}" />
                  </div>
                  <div class="cm-sf-input-group" style="display: none;">
                    <input id="cm-in-name" type="hidden" value="${initialFullName}" />
                  </div>
                </div>

                <div class="cm-sf-input-group">
                  <label>Address line 1</label>
                  <input id="cm-in-a1" type="text" value="${address1}" />
                </div>

                <div class="cm-sf-input-group">
                  <label>Apartment, suite, etc. (optional)</label>
                  <input id="cm-in-a2" type="text" value="${address2}" />
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px;">
                  <div class="cm-sf-input-group">
                    <label>City</label>
                    <input id="cm-in-city" type="text" value="${city}" />
                  </div>
                  <div class="cm-sf-input-group">
                    <label>State / Province</label>
                    <input id="cm-in-prov" type="text" value="${province}" />
                  </div>
                  <div class="cm-sf-input-group">
                    <label>ZIP / Postal code</label>
                    <input id="cm-in-zip" type="text" value="${zip}" />
                  </div>
                </div>
              </div>

              <!-- Other panels (Items, Quantity, Cancel) -->
              <div id="cm-panel-items" style="display: ${initialTab === "items" ? "block" : "none"};">
                <h3 style="font-size: 15px; font-weight: 700; margin: 0 0 12px 0;">Select new variants</h3>
                ${items.map((it: any, idx: number) => `
                  <div style="padding: 12px 0; border-bottom: 1px solid #f1f5f9;">
                    <div style="font-weight: 700; font-size: 13.5px; margin-bottom: 6px;">${it.title}</div>
                    <select class="cm-select cm-var-select" data-idx="${idx}" style="font-size: 13px;">
                      ${it.availableVariants.length > 0
                        ? it.availableVariants.map((v: any) => `
                            <option value="${v.id}" ${v.id === (it.variant?.id) ? "selected" : ""}>
                              ${v.title} (${currency} ${v.price.toFixed(2)})
                            </option>
                          `).join("")
                        : `<option value="${it.variant?.id || 'default'}">${it.variant?.title || 'Default Variant'} (${currency} ${it.unitPrice.toFixed(2)})</option>`
                      }
                    </select>
                  </div>
                `).join("")}
              </div>

              <div id="cm-panel-quantity" style="display: ${initialTab === "quantity" ? "block" : "none"};">
                <h3 style="font-size: 15px; font-weight: 700; margin: 0 0 12px 0;">Update item quantities</h3>
                ${items.map((it: any, idx: number) => `
                  <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #f1f5f9;">
                    <div>
                      <div style="font-weight: 700; font-size: 13.5px;">${it.title}</div>
                      <div style="font-size: 12px; color: #64748b;">${currency} ${it.unitPrice.toFixed(2)} each</div>
                    </div>
                    <div class="cm-sf-qty-ctrl">
                      <button type="button" class="cm-sf-qty-btn" data-idx="${idx}" data-delta="-1">−</button>
                      <span id="cm-qty-${idx}" class="cm-sf-qty-val">${it.quantity}</span>
                      <button type="button" class="cm-sf-qty-btn" data-idx="${idx}" data-delta="1">+</button>
                    </div>
                  </div>
                `).join("")}
              </div>

              <div id="cm-panel-cancel" style="display: ${initialTab === "cancel" ? "block" : "none"};">
                <div style="background: #fef2f2; border: 1px solid #fee2e2; border-radius: 8px; padding: 14px; color: #991b1b; margin-bottom: 16px;">
                  <strong>⚠️ Cancel entire order?</strong>
                  <div style="font-size: 12.5px; margin-top: 4px;">All items will be cancelled and a full refund will be processed back to your original payment method.</div>
                </div>
              </div>
            </div>

            <!-- Right Sidebar in Step 2: Live Summary -->
            <div class="cm-sf-card">
              <h3 style="font-size: 16px; font-weight: 700; margin: 0 0 14px 0;">Current Order Summary</h3>
              <div style="border-bottom: 1px solid #f1f5f9; padding-bottom: 12px; margin-bottom: 12px;">
                ${items.map((it: any, idx: number) => `
                  <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 6px;">
                    <span>${it.title} (x<span id="cm-rqty-${idx}">${it.quantity}</span>)</span>
                    <span id="cm-itotal-${idx}" style="font-weight: 600;">${currency} ${(it.quantity * it.unitPrice).toFixed(2)}</span>
                  </div>
                `).join("")}
              </div>

              <div style="display: flex; justify-content: space-between; font-size: 13.5px; margin-bottom: 6px;">
                <span style="color: #64748b;">Original total</span>
                <span>${currency} ${orderTotal.toFixed(2)}</span>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 13.5px; margin-bottom: 6px;">
                <span style="color: #64748b;">Updated total</span>
                <span class="cm-sub-val" style="font-weight: 700;">${currency} ${orderTotal.toFixed(2)}</span>
              </div>
              <div id="cm-delta-box" style="display: none; padding: 6px 10px; border-radius: 6px; margin-top: 10px; font-size: 13px;">
                <span id="cm-delta-label" style="font-weight: 600;">Difference</span>
                <span class="cm-delta-val" style="font-weight: 700;">No change</span>
              </div>
            </div>
          </div>

          <div class="cm-sf-nav-bar">
            <button type="button" class="cm-btn-outline cm-btn-goto" data-goto="1" style="padding: 10px 20px;">
              ← Back
            </button>
            <button type="button" class="cm-btn-primary cm-btn-goto" data-goto="3" style="padding: 10px 24px;">
              Review changes →
            </button>
          </div>
        </div>

        <!-- STEP 3: REVIEW & IMPACT -->
        <div id="cm-step-3" style="display: none;">
          <div class="cm-sf-order-header-card">
            <div style="display: flex; align-items: center; gap: 12px;">
              <div style="width: 42px; height: 42px; border-radius: 8px; background: #e8f5e9; color: #008060; display: flex; align-items: center; justify-content: center; font-size: 20px;">📋</div>
              <div>
                <div style="font-size: 18px; font-weight: 800;">Review your changes</div>
                <div style="font-size: 12.5px; color: #64748b;">Verify all changes and financial impact before submitting.</div>
              </div>
            </div>
            <div class="cm-sf-timer-pill">
              <div style="font-size: 11px; color: #78350f;">Edit window closes in</div>
              <div class="cm-sf-timer-val cm-timer-val">${initialTimerStr}</div>
            </div>
          </div>

          <div class="cm-sf-layout-grid">
            <div class="cm-sf-card">
              <h3 style="font-size: 16px; font-weight: 700; margin: 0 0 14px 0;">Updated Shipping Address</h3>
              <div id="cm-review-address-text" style="font-size: 13.5px; color: #334155; line-height: 1.5; background: #f8fafc; padding: 12px; border-radius: 8px; border: 1px solid #e2e8f0;">
                ${initialFullName} • ${address1}${address2 ? ', ' + address2 : ''}, ${city}, ${province} ${zip}
              </div>

              <h3 style="font-size: 16px; font-weight: 700; margin: 20px 0 14px 0;">Updated Order Items</h3>
              <div id="cm-review-items-list">
                ${items.map((it: any) => `
                  <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 6px;">
                    <span>${it.title} (Qty: ${it.quantity})</span>
                    <span style="font-weight: 600;">${currency} ${(it.quantity * it.unitPrice).toFixed(2)}</span>
                  </div>
                `).join("")}
              </div>
            </div>

            <!-- Right: Financial Impact -->
            <div class="cm-sf-card">
              <h3 style="font-size: 16px; font-weight: 700; margin: 0 0 16px 0;">Financial Impact</h3>
              <div style="display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 13.5px;">
                <span style="color: #64748b;">Original Order Total</span>
                <span style="font-weight: 600;">${currency} ${orderTotal.toFixed(2)}</span>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 13.5px;">
                <span style="color: #64748b;">New Calculated Total</span>
                <span class="cm-sub-val" style="font-weight: 600;">${currency} ${orderTotal.toFixed(2)}</span>
              </div>
              <div style="display: flex; justify-content: space-between; border-top: 1px solid #e2e8f0; padding-top: 12px; margin-top: 12px; font-size: 16px; font-weight: 800;">
                <span>Price Difference</span>
                <span class="cm-delta-val" style="color: #64748b;">No change</span>
              </div>
            </div>
          </div>

          <div class="cm-sf-nav-bar">
            <button type="button" class="cm-btn-outline cm-btn-goto" data-goto="2" style="padding: 10px 20px;">
              ← Back
            </button>
            <button type="button" class="cm-btn-primary cm-btn-goto" data-goto="4" style="padding: 10px 24px;">
              Continue to payment →
            </button>
          </div>
        </div>

        <!-- STEP 4: PAYMENT / CONFIRMATION -->
        <div id="cm-step-4" style="display: none;">
          <div class="cm-sf-order-header-card">
            <div style="display: flex; align-items: center; gap: 12px;">
              <div id="cm-fin-icon" style="width: 42px; height: 42px; border-radius: 8px; background: #e8f5e9; color: #008060; display: flex; align-items: center; justify-content: center; font-size: 20px;">🔒</div>
              <div>
                <div id="cm-fin-title" style="font-size: 18px; font-weight: 800;">Confirm Order Changes</div>
                <div id="cm-fin-desc" style="font-size: 12.5px; color: #64748b;">Final step before changes are synced with Shopify.</div>
              </div>
            </div>
            <div class="cm-sf-timer-pill">
              <div style="font-size: 11px; color: #78350f;">Edit window closes in</div>
              <div class="cm-sf-timer-val cm-timer-val">${initialTimerStr}</div>
            </div>
          </div>

          <div style="max-width: 680px; margin: 0 auto;">
            <div class="cm-sf-card" style="text-align: center;">
              <div id="cm-fin-notice" style="background: #f0fdf4; border: 1px solid #bbf7d0; color: #14532d; padding: 10px 14px; border-radius: 8px; font-size: 12.5px; text-align: left; margin-bottom: 20px;">
                ℹ️ Once confirmed, your order will be updated immediately and you'll receive a confirmation email.
              </div>

              <div id="cm-err-box" style="display: none; background: #fef2f2; border: 1px solid #fecaca; color: #dc2626; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; text-align: left;"></div>

              <button id="cm-save-btn" type="button" class="cm-btn-primary" style="width: 100%; padding: 14px 0; font-size: 15px;">
                ✓ Confirm Order Changes
              </button>
            </div>
          </div>

          <div class="cm-sf-nav-bar">
            <button type="button" class="cm-btn-outline cm-btn-goto" data-goto="3" style="padding: 10px 20px;">
              ← Back
            </button>
          </div>
        </div>

        <!-- Direct Checkout Redirect Overlay -->
        <div id="cm-redirect-overlay" style="display: none; position: fixed; inset: 0; background: rgba(15, 23, 42, 0.75); backdrop-filter: blur(4px); z-index: 99999; align-items: center; justify-content: center; text-align: center; padding: 20px;">
          <div style="background: #ffffff; color: #1e293b; border-radius: 16px; padding: 36px 30px; max-width: 440px; box-shadow: 0 20px 40px rgba(0,0,0,0.25); border: 1px solid #e2e8f0; margin: auto;">
            <div class="cm-spinner"></div>
            <h3 id="cm-redirect-title" style="font-size: 19px; font-weight: 800; margin: 0 0 8px 0; color: #0f172a;">Redirecting to Shopify Checkout</h3>
            <p id="cm-redirect-msg" style="font-size: 14px; color: #64748b; margin: 0 0 16px 0; line-height: 1.5;">Directing you to the secure Shopify checkout to complete payment for your additional items...</p>
            <div style="font-size: 12px; color: #94a3b8;">Please wait while we redirect you.</div>
          </div>
        </div>

        <!-- STEP 5: ORDER UPDATED / DONE (RICH 2-COLUMN DESIGN) -->
        <div id="cm-step-5" style="display: none;">
          ${isPaymentReturn ? `
            <div id="cm-payment-return-banner" style="background: #f0fdf4; border: 1.5px solid #86efac; color: #15803d; border-radius: 10px; padding: 12px 16px; margin-bottom: 20px; font-size: 14px; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 8px;">
              <span>🎉</span> Payment Received! Your order has been updated and confirmed in full.
            </div>
          ` : ""}

          <div class="cm-done-grid">
            <!-- Left Column -->
            <div class="cm-done-main">
              <!-- Hero Card -->
              <div class="cm-done-hero-card">
                <div class="cm-done-hero-icon">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </div>
                <div style="flex: 1;">
                  <h1 id="cm-done-title" class="cm-done-title">Your order has been updated!</h1>
                  <p id="cm-done-sub" class="cm-done-sub">Your changes have been successfully applied.</p>
                  <button type="button" id="cm-toggle-details-btn" class="cm-done-details-btn">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                      <polyline points="14 2 14 8 20 8"></polyline>
                      <line x1="16" y1="13" x2="8" y2="13"></line>
                      <line x1="16" y1="17" x2="8" y2="17"></line>
                      <polyline points="10 9 9 9 8 9"></polyline>
                    </svg>
                    <span id="cm-toggle-details-text">View updated order details</span>
                  </button>
                </div>
              </div>

              <!-- Optional Collapsible Order Details Drawer -->
              <div id="cm-order-details-drawer" class="cm-done-card" style="display: none; border-left: 4px solid #008060; margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                  <span style="font-weight: 700; font-size: 14px;">Updated Order Details (${order.name})</span>
                  <span style="font-size: 12px; color: #15803d; background: #dcfce7; padding: 2px 8px; border-radius: 8px; font-weight: 600;">Confirmed</span>
                </div>
                <div id="cm-details-items-container" style="border-top: 1px solid #f1f5f9; padding-top: 10px;">
                  ${items.map((item: any) => `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #f8fafc; font-size: 13px;">
                      <div>
                        <span style="font-weight: 600;">${item.title}</span>
                        <span style="color: #64748b; margin-left: 6px;">x${item.quantity}</span>
                      </div>
                      <span style="font-weight: 600;">${currency} ${(item.quantity * item.unitPrice).toFixed(2)}</span>
                    </div>
                  `).join("")}
                </div>
                <div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid #f1f5f9; font-size: 12.5px; color: #475569;">
                  <strong>Shipping to:</strong> <span id="cm-details-address">${initialFullName}, ${address1}${address2 ? ', ' + address2 : ''}, ${city}, ${province} ${zip}</span>
                </div>
              </div>

              <!-- What was updated Card -->
              <div class="cm-done-card">
                <div class="cm-done-card-header">
                  <h2 class="cm-done-card-title">What was updated</h2>
                  <span id="cm-changes-count-badge" class="cm-badge-pill-green">2 changes</span>
                </div>
                <div id="cm-updated-items-list" class="cm-updated-list">
                  <div class="cm-updated-item">
                    <div class="cm-updated-item-left">
                      <div class="cm-updated-item-icon">📍</div>
                      <div>
                        <div class="cm-updated-item-title">Shipping address</div>
                        <div id="cm-done-addr-sub" class="cm-updated-item-sub">Updated to ${address1 ? `${address1}${address2 ? `, ${address2}` : ""}, ${city}, ${province} ${zip}` : "Confirmed delivery address"}</div>
                      </div>
                    </div>
                    <span class="cm-badge-pill-updated">Updated</span>
                  </div>
                  <div class="cm-updated-item">
                    <div class="cm-updated-item-left">
                      <div class="cm-updated-item-icon">#</div>
                      <div>
                        <div id="cm-done-item-title" class="cm-updated-item-title">Quantity for ${items[0]?.title || "Order Item"}</div>
                        <div id="cm-done-item-sub" class="cm-updated-item-sub">Updated to ${items[0]?.quantity || 1}</div>
                      </div>
                    </div>
                    <span class="cm-badge-pill-updated">Updated</span>
                  </div>
                </div>
              </div>

              <!-- Order summary (updated) Card -->
              <div class="cm-done-card">
                <h2 class="cm-done-card-title" style="margin-bottom: 16px;">Order summary (updated)</h2>
                <div class="cm-summary-flow">
                  <div class="cm-summary-box">
                    <div class="cm-summary-label">Original total</div>
                    <div id="cm-done-orig-total" class="cm-summary-val">${currency} ${orderTotal.toFixed(2)}</div>
                  </div>
                  <div class="cm-summary-arrow">›</div>
                  <div class="cm-summary-box">
                    <div class="cm-summary-label">Changes</div>
                    <div id="cm-done-changes-val" class="cm-summary-val cm-summary-delta">+ ${currency} 0.00</div>
                  </div>
                  <div class="cm-summary-arrow">›</div>
                  <div class="cm-summary-box">
                    <div class="cm-summary-label">New order total</div>
                    <div id="cm-done-new-total" class="cm-summary-val cm-summary-total">${currency} ${orderTotal.toFixed(2)}</div>
                  </div>
                </div>
              </div>

              <!-- Direct Checkout Retry Box (if payment required and not completed yet) -->
              <div id="cm-step5-direct-pay-box" style="display: none; margin-bottom: 20px;">
                <a id="cm-step5-direct-pay-btn" href="#" target="_top" class="cm-btn-primary" style="width: 100%; padding: 14px 0; font-size: 15px; text-decoration: none; box-shadow: 0 4px 12px rgba(0, 128, 96, 0.25);">
                  🔒 Proceed to Shopify Checkout →
                </a>
                <div style="font-size: 12px; color: #64748b; margin-top: 8px; text-align: center;">
                  Click above if you were not automatically redirected to complete payment.
                </div>
              </div>

              <!-- Email Banner -->
              <div class="cm-done-email-banner">
                <div class="cm-done-email-icon">ℹ️</div>
                <div class="cm-done-email-text">
                  A confirmation email with your updated order details has been sent to <strong id="cm-done-customer-email">${order.email || "your email address"}</strong>
                </div>
              </div>
            </div>

            <!-- Right Sidebar -->
            <div class="cm-done-sidebar">
              <!-- What happens next? Card -->
              <div class="cm-done-card">
                <h2 class="cm-done-card-title" style="margin-bottom: 18px;">What happens next?</h2>
                <div class="cm-next-steps-list">
                  <div class="cm-next-step-item">
                    <div class="cm-next-step-icon">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                        <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                        <line x1="12" y1="22.08" x2="12" y2="12"></line>
                      </svg>
                    </div>
                    <div>
                      <div class="cm-next-step-heading">We've notified ${storeName}</div>
                      <div class="cm-next-step-desc">The store has been notified about your updated order.</div>
                    </div>
                  </div>

                  <div class="cm-next-step-item">
                    <div class="cm-next-step-icon">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="1" y="3" width="15" height="13"></rect>
                        <polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon>
                        <circle cx="5.5" cy="18.5" r="2.5"></circle>
                        <circle cx="18.5" cy="18.5" r="2.5"></circle>
                      </svg>
                    </div>
                    <div>
                      <div class="cm-next-step-heading">Your order is being prepared</div>
                      <div class="cm-next-step-desc">You'll receive shipping updates via email.</div>
                    </div>
                  </div>

                  <div class="cm-next-step-item">
                    <div class="cm-next-step-icon">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
                        <polyline points="22,6 12,13 2,6"></polyline>
                      </svg>
                    </div>
                    <div>
                      <div class="cm-next-step-heading">Need help?</div>
                      <div class="cm-next-step-desc">Contact ${storeName} if you have any questions about your order.</div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Something went wrong? Card -->
              <div class="cm-done-help-card">
                <h3 class="cm-help-title">Something went wrong?</h3>
                <p class="cm-help-sub">If your order wasn't updated, here are some common reasons.</p>
                
                <div class="cm-help-items">
                  <div class="cm-help-item">
                    <div class="cm-help-item-icon">💳</div>
                    <div>
                      <div class="cm-help-item-title">Payment failed</div>
                      <div class="cm-help-item-desc">Your payment couldn't be processed. Please try again.</div>
                      <a href="javascript:void(0)" id="cm-help-retry-pay" class="cm-help-link">Try payment again</a>
                    </div>
                  </div>

                  <div class="cm-help-item">
                    <div class="cm-help-item-icon">⏱️</div>
                    <div>
                      <div class="cm-help-item-title">Edit window expired</div>
                      <div class="cm-help-item-desc">The edit window has closed. Contact the store for help.</div>
                      <a href="/" class="cm-help-link">Contact store</a>
                    </div>
                  </div>

                  <div class="cm-help-item">
                    <div class="cm-help-item-icon">⚠️</div>
                    <div>
                      <div class="cm-help-item-title">Changes couldn't be applied</div>
                      <div class="cm-help-item-desc">Some items may no longer be eligible for editing.</div>
                      <a href="javascript:void(0)" id="cm-help-view-details" class="cm-help-link">View details</a>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Bottom Navigation (Clean Back to store button) -->
          <div class="cm-done-bottom-nav">
            <a href="/" class="cm-btn-outline cm-btn-back-store" style="padding: 10px 24px;">
              ← Back to store
            </a>
          </div>
        </div>
      </div>

      <script>
        (function() {
          var cmToken = ${JSON.stringify(session?.token || token)};
          var cmAppOrigin = ${JSON.stringify(appOrigin || "")};
          if (cmAppOrigin.startsWith("http://") && !cmAppOrigin.includes("localhost") && !cmAppOrigin.includes("127.0.0.1")) {
            cmAppOrigin = cmAppOrigin.replace("http://", "https://");
          }
          var cmCurrency = ${JSON.stringify(currency || "USD")};
          var cmOrderTotal = ${orderTotal};
          var cmItems = ${JSON.stringify(sanitizedItems)};
          var cmSecs = ${remainingSeconds};
          var cmActiveTab = ${JSON.stringify(initialTab)};
          var cmPerms = {
            address: ${Boolean(canAddress)},
            items: ${Boolean(canVariant)},
            quantity: ${Boolean(canQuantity)},
            cancel: ${Boolean(canCancel)}
          };
          var cmDifference = 0;
          var cmPreviewTimeout = null;
          var cmIsCompleted = ${Boolean(session.isCompleted || session.status === "COMPLETED")};
          var cmInitialStatus = ${JSON.stringify(session.status || "ACTIVE")};
          var cmInitialPaymentUrl = ${JSON.stringify(session.paymentUrl || "")};
          var cmPaymentPollTimer = null;

          function formatMoney(val) {
            var num = Number(val);
            if (isNaN(num)) num = 0;
            var sign = num < 0 ? '-' : '';
            var absFormatted = Math.abs(num).toFixed(2);
            var symbols = {
              INR: '₹',
              USD: '$',
              EUR: '€',
              GBP: '£',
              CAD: 'CA$',
              AUD: 'AU$',
              JPY: '¥'
            };
            var sym = symbols[cmCurrency] || (cmCurrency + ' ');
            return sign + sym + absFormatted;
          }

          function cmFetchApi(path, options) {
            var url1 = (cmAppOrigin ? cmAppOrigin : '') + path;
            return fetch(url1, options).then(function(r) {
              if (r.status === 404) {
                var altPath = path.startsWith('/apps/cartmend')
                  ? path.replace('/apps/cartmend', '')
                  : ('/apps/cartmend' + path);
                var url2 = (cmAppOrigin ? cmAppOrigin : '') + altPath;
                if (url2 !== url1) {
                  return fetch(url2, options).then(function(r2) {
                    if (r2.status === 404 && path.includes('/commit')) {
                      return fetch(window.location.href, options);
                    }
                    return r2;
                  }).catch(function() { return r; });
                }
              }
              return r;
            });
          }

          function updateTimer() {
            if (cmSecs <= 0) {
              var tEls = document.querySelectorAll('.cm-timer-val');
              for (var i = 0; i < tEls.length; i++) tEls[i].innerText = 'Window Closed (00m : 00s)';
              var gotoBtns = document.querySelectorAll('.cm-btn-goto');
              for (var j = 0; j < gotoBtns.length; j++) {
                if (gotoBtns[j].getAttribute('data-goto') === '2') {
                  gotoBtns[j].disabled = true;
                  gotoBtns[j].innerText = 'Order Edit Window Closed';
                  gotoBtns[j].style.opacity = '0.6';
                  gotoBtns[j].style.cursor = 'not-allowed';
                }
              }
              return;
            }
            var h = Math.floor(cmSecs / 3600);
            var m = Math.floor((cmSecs % 3600) / 60);
            var s = cmSecs % 60;
            var str = (h > 0 ? (h < 10 ? '0' : '') + h + 'h ' : '') + (m < 10 ? '0' : '') + m + 'm : ' + (s < 10 ? '0' : '') + s + 's';
            var tEls = document.querySelectorAll('.cm-timer-val');
            for (var i = 0; i < tEls.length; i++) tEls[i].innerText = str;
          }

          setInterval(function() {
            if (cmSecs > 0) {
              cmSecs--;
              updateTimer();
            }
          }, 1000);
          updateTimer();

          window.cmGoTo = function(n) {
            for (var i = 1; i <= 5; i++) {
              var el = document.getElementById('cm-step-' + i);
              if (el) el.style.display = (i === n) ? 'block' : 'none';
            }
            var h = document.getElementById('cm-stepper-header');
            if (h) h.style.display = (n > 1) ? 'block' : 'none';

            for (var p = 1; p <= 5; p++) {
              var sp = document.getElementById('cm-pstep-' + p);
              if (sp) {
                if (n === 5) {
                  sp.className = 'cm-sf-progress-step completed active';
                  var c = sp.querySelector('.cm-sf-progress-circle');
                  if (c) c.innerHTML = '✓';
                } else {
                  sp.className = 'cm-sf-progress-step ' + (p === n ? 'active' : (p < n ? 'completed' : ''));
                  var c = sp.querySelector('.cm-sf-progress-circle');
                  if (c) c.innerHTML = (p < n) ? '✓' : p;
                }
              }
              var conn = document.getElementById('cm-pconn-' + p);
              if (conn) conn.className = 'cm-sf-progress-connector ' + ((p < n || n === 5) ? 'filled' : '');
            }

            if (n === 3) updateReviewStep();
            if (n === 5) updateDonePageDetails();
            cmCalc();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          };

          window.cmSetTab = function(t) {
            if (!cmPerms[t]) return;
            cmActiveTab = t;
            var tabs = ['address', 'items', 'quantity', 'cancel'];
            for (var i = 0; i < tabs.length; i++) {
              var tb = tabs[i];
              var card = document.getElementById('cm-card-' + tb);
              var panel = document.getElementById('cm-panel-' + tb);
              if (card) {
                if (tb === t) {
                  card.classList.add('active');
                  var r = card.querySelector('.cm-sf-action-radio');
                  if (r) r.innerHTML = '✓';
                } else {
                  card.classList.remove('active');
                  var r = card.querySelector('.cm-sf-action-radio');
                  if (r) r.innerHTML = '';
                }
              }
              if (panel) panel.style.display = (tb === t && cmPerms[tb]) ? 'block' : 'none';
            }
            cmCalc();
          };

          window.cmQty = function(idx, d) {
            if (!cmItems[idx]) return;
            cmItems[idx].currentQty = Math.max(1, (cmItems[idx].currentQty || cmItems[idx].quantity) + d);
            var qEl = document.getElementById('cm-qty-' + idx);
            if (qEl) qEl.innerText = cmItems[idx].currentQty;
            var rqEl = document.getElementById('cm-rqty-' + idx);
            if (rqEl) rqEl.innerText = cmItems[idx].currentQty;
            cmCalc();
          };

          window.cmVar = function(idx, sel) {
            if (!cmItems[idx]) return;
            cmItems[idx].selectedVarId = sel.value;
            var v = (cmItems[idx].availableVariants || []).find(function(item) { return item.id === sel.value; });
            if (v) cmItems[idx].currentPrice = v.price;
            cmCalc();
          };

          function buildPayload(isCancel) {
            var payload = {};
            if (isCancel || cmActiveTab === 'cancel') {
              payload.isCancellation = true;
              payload.removedLineItems = (cmItems || []).map(function(it) { return { lineItemId: it.id }; });
            } else {
              var qChanges = (cmItems || [])
                .filter(function(it) { return it.currentQty && it.currentQty !== it.quantity; })
                .map(function(it) { return { lineItemId: it.id, quantity: it.currentQty, oldQuantity: it.quantity }; });
              if (qChanges.length > 0) payload.quantityChanges = qChanges;

              var vChanges = (cmItems || [])
                .filter(function(it) { return it.selectedVarId && it.selectedVarId !== (it.variant ? it.variant.id : ''); })
                .map(function(it) { return { oldLineItemId: it.id, newVariantId: it.selectedVarId, quantity: it.currentQty || it.quantity }; });
              if (vChanges.length > 0) payload.variantChanges = vChanges;

              var fnEl = document.getElementById('cm-in-fname');
              var lnEl = document.getElementById('cm-in-lname');
              var nmEl = document.getElementById('cm-in-name');
              var a1El = document.getElementById('cm-in-a1');
              var a2El = document.getElementById('cm-in-a2');
              var cityEl = document.getElementById('cm-in-city');
              var provEl = document.getElementById('cm-in-prov');
              var zipEl = document.getElementById('cm-in-zip');
              var phoneEl = document.getElementById('cm-in-phone');

              var curFname = (fnEl ? fnEl.value : '').trim();
              var curLname = (lnEl ? lnEl.value : '').trim();
              var curName = (nmEl ? nmEl.value : '').trim();
              var curA1 = (a1El ? a1El.value : '').trim();
              var curA2 = (a2El ? a2El.value : '').trim();
              var curCity = (cityEl ? cityEl.value : '').trim();
              var curProv = (provEl ? provEl.value : '').trim();
              var curZip = (zipEl ? zipEl.value : '').trim();
              var curPhone = (phoneEl ? phoneEl.value : '').trim();

              var origFname = ${JSON.stringify(initialFirstName)};
              var origLname = ${JSON.stringify(initialLastName)};
              var origA1 = ${JSON.stringify(address1)};
              var origA2 = ${JSON.stringify(address2)};
              var origCity = ${JSON.stringify(city)};
              var origProv = ${JSON.stringify(province)};
              var origZip = ${JSON.stringify(zip)};
              var origPhone = ${JSON.stringify(phone)};

              var addrChanged = (
                curFname !== origFname ||
                curLname !== origLname ||
                curA1 !== origA1 ||
                curA2 !== origA2 ||
                curCity !== origCity ||
                curProv !== origProv ||
                curZip !== origZip ||
                curPhone !== origPhone
              );

              if (curA1 && (addrChanged || cmActiveTab === 'address')) {
                var finalFirst = curFname || (curName ? curName.split(' ')[0] : '') || origFname || 'Customer';
                var finalLast = curLname || (curName ? curName.split(' ').slice(1).join(' ') : '') || origLname || finalFirst;
                if (!finalLast || !finalLast.trim()) finalLast = finalFirst || 'Customer';
                if (!finalFirst || !finalFirst.trim()) finalFirst = finalLast || 'Customer';

                payload.shippingAddress = {
                  firstName: finalFirst,
                  lastName: finalLast,
                  address1: curA1,
                  address2: curA2,
                  city: curCity,
                  province: curProv,
                  zip: curZip,
                  country: ${JSON.stringify(country || "United States")},
                  phone: curPhone
                };
              }
            }
            return payload;
          }

          function cmCalc() {
            if (cmActiveTab === 'cancel') {
              (cmItems || []).forEach(function(it, idx) {
                var itEl = document.getElementById('cm-itotal-' + idx);
                if (itEl) itEl.innerHTML = '<span style="text-decoration: line-through; color: #94a3b8; font-size: 11.5px; margin-right: 4px;">' + formatMoney((it.currentQty || it.quantity) * (it.currentPrice !== undefined ? it.currentPrice : it.unitPrice)) + '</span><span style="color: #dc2626; font-weight: 700;">' + formatMoney(0) + '</span>';
                var rqEl = document.getElementById('cm-rqty-' + idx);
                if (rqEl) rqEl.innerText = '0';
              });

              var sub = 0;
              var delta = -cmOrderTotal;
              cmDifference = delta;
              updateFinancialUI(sub, delta);

              if (cmPreviewTimeout) clearTimeout(cmPreviewTimeout);
              cmPreviewTimeout = setTimeout(function() {
                fetchShopifyPreview();
              }, 350);
              return;
            }

            var sub = 0;
            (cmItems || []).forEach(function(it, idx) {
              var q = it.currentQty || it.quantity;
              var p = it.currentPrice !== undefined ? it.currentPrice : it.unitPrice;
              sub += q * p;
              var itEl = document.getElementById('cm-itotal-' + idx);
              if (itEl) itEl.innerText = formatMoney(q * p);
              var rqEl = document.getElementById('cm-rqty-' + idx);
              if (rqEl) rqEl.innerText = q;
            });

            var delta = Math.round((sub - cmOrderTotal) * 100) / 100;
            cmDifference = delta;
            updateFinancialUI(sub, delta);

            if (cmPreviewTimeout) clearTimeout(cmPreviewTimeout);
            cmPreviewTimeout = setTimeout(function() {
              fetchShopifyPreview();
            }, 350);
          }

          function fetchShopifyPreview() {
            var payload = buildPayload(cmActiveTab === 'cancel');
            var path = '/api/customer/edit/' + encodeURIComponent(cmToken) + '/preview';

            cmFetchApi(path, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify(payload)
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (data && data.calculatedTotal !== undefined) {
                cmDifference = data.difference;
                updateFinancialUI(data.calculatedTotal, data.difference, data.subtotal, data.totalTax);
              }
            })
            .catch(function(e) {
              console.warn('Shopify preview calculation fallback:', e);
            });
          }

          function updateFinancialUI(calcTotal, delta, subtotal, totalTax) {
            var subEls = document.querySelectorAll('.cm-sub-val');
            for (var i = 0; i < subEls.length; i++) subEls[i].innerText = formatMoney(calcTotal);

            var calcTaxEls = document.querySelectorAll('.cm-calc-tax');
            for (var i = 0; i < calcTaxEls.length; i++) calcTaxEls[i].innerText = formatMoney(totalTax !== undefined ? totalTax : 0);

            var deltaBox = document.getElementById('cm-delta-box');
            var deltaLabel = document.getElementById('cm-delta-label');
            if (deltaBox && deltaLabel) {
              if (delta !== 0) {
                deltaBox.style.display = 'flex';
                deltaBox.style.justifyContent = 'space-between';
                deltaBox.style.background = delta > 0 ? '#eff6ff' : '#fef3c7';
                deltaBox.style.border = delta > 0 ? '1px solid #bfdbfe' : '1px solid #fde68a';
                deltaLabel.innerText = delta > 0 ? 'Payment required' : 'Refund due';
                deltaLabel.style.color = delta > 0 ? '#1e40af' : '#92400e';
              } else {
                deltaBox.style.display = 'none';
              }
            }

            var deltaEls = document.querySelectorAll('.cm-delta-val');
            for (var i = 0; i < deltaEls.length; i++) {
              var e = deltaEls[i];
              if (delta > 0) {
                e.innerText = '+' + formatMoney(delta);
                e.style.color = '#008060';
              } else if (delta < 0) {
                e.innerText = '-' + formatMoney(Math.abs(delta));
                e.style.color = '#dc2626';
              } else {
                e.innerText = 'No change';
                e.style.color = '#64748b';
              }
            }

            var finIcon = document.getElementById('cm-fin-icon');
            var finTitle = document.getElementById('cm-fin-title');
            var finDesc = document.getElementById('cm-fin-desc');
            var finNotice = document.getElementById('cm-fin-notice');
            var saveBtn = document.getElementById('cm-save-btn');

            if (cmActiveTab === 'cancel') {
              if (finIcon) { finIcon.innerText = "💰"; finIcon.style.background = "#fef2f2"; finIcon.style.color = "#dc2626"; }
              if (finTitle) finTitle.innerText = "Confirm Order Cancellation (" + formatMoney(cmOrderTotal) + " Refund)";
              if (finDesc) finDesc.innerText = "All items will be cancelled and a full refund will be processed back to your original payment method.";
              if (finNotice) {
                finNotice.style.background = "#fef2f2";
                finNotice.style.border = "1px solid #fee2e2";
                finNotice.style.color = "#991b1b";
                finNotice.innerText = "⚠️ Cancelling your order will cancel all items and issue a full refund of " + formatMoney(cmOrderTotal) + " back to your original payment method via Shopify.";
              }
              if (saveBtn) saveBtn.innerText = "💰 Confirm Order Cancellation & Receive " + formatMoney(cmOrderTotal) + " Refund";
            } else if (delta > 0) {
              if (finIcon) { finIcon.innerText = "🔒"; finIcon.style.background = "#eff6ff"; finIcon.style.color = "#0284c7"; }
              if (finTitle) finTitle.innerText = "Proceed to payment (" + formatMoney(delta) + ")";
              if (finDesc) finDesc.innerText = "You will be directly redirected to Shopify Checkout to pay the additional balance.";
              if (finNotice) {
                finNotice.style.background = "#eff6ff";
                finNotice.style.border = "1px solid #bfdbfe";
                finNotice.style.color = "#1e40af";
                finNotice.innerText = "ℹ️ Clicking below will update your order and directly take you to Shopify Checkout to complete payment.";
              }
              if (saveBtn) saveBtn.innerText = "🔒 Proceed to Checkout (+" + formatMoney(delta) + ") →";
            } else if (delta < 0) {
              if (finIcon) { finIcon.innerText = "💰"; finIcon.style.background = "#fef3c7"; finIcon.style.color = "#d97706"; }
              if (finTitle) finTitle.innerText = "Refund due (" + formatMoney(Math.abs(delta)) + ")";
              if (finDesc) finDesc.innerText = "A refund will be automatically issued back to your original payment method via Shopify.";
              if (finNotice) {
                finNotice.style.background = "#fffbeb";
                finNotice.style.border = "1px solid #fde68a";
                finNotice.style.color = "#92400e";
                finNotice.innerText = "ℹ️ Refund will be processed immediately upon confirmation using Shopify's native refund engine.";
              }
              if (saveBtn) saveBtn.innerText = "💰 Confirm Changes & Receive " + formatMoney(Math.abs(delta)) + " Refund";
            } else {
              if (finIcon) { finIcon.innerText = "🔒"; finIcon.style.background = "#f0fdf4"; finIcon.style.color = "#008060"; }
              if (finTitle) finTitle.innerText = "Confirm Order Changes";
              if (finDesc) finDesc.innerText = "Final step before changes are synced with Shopify.";
              if (finNotice) {
                finNotice.style.background = "#f0fdf4";
                finNotice.style.border = "#bbf7d0";
                finNotice.style.color = "#14532d";
                finNotice.innerText = "ℹ️ Once confirmed, your order will be updated immediately and you will receive a confirmation email.";
              }
              if (saveBtn) saveBtn.innerText = "✓ Confirm Order Changes";
            }
          }

          function updateReviewStep() {
            var fn = document.getElementById('cm-in-fname');
            var ln = document.getElementById('cm-in-lname');
            var nm = document.getElementById('cm-in-name');
            var a1 = document.getElementById('cm-in-a1');
            var a2 = document.getElementById('cm-in-a2');
            var city = document.getElementById('cm-in-city');
            var prov = document.getElementById('cm-in-prov');
            var zip = document.getElementById('cm-in-zip');

            var displayName = (fn && ln && (fn.value || ln.value))
              ? (fn.value + ' ' + ln.value).trim()
              : (nm ? nm.value : 'Customer');

            var addrText = document.getElementById('cm-review-address-text');
            if (addrText) {
              addrText.innerText = displayName + ' • ' + (a1 ? a1.value : '') + (a2 && a2.value ? ', ' + a2.value : '') + ', ' + (city ? city.value : '') + ', ' + (prov ? prov.value : '') + ' ' + (zip ? zip.value : '');
            }

            var listEl = document.getElementById('cm-review-items-list');
            if (listEl) {
              var html = '';
              if (cmActiveTab === 'cancel') {
                (cmItems || []).forEach(function(it) {
                  html += '<div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px;"><span style="color: #64748b; text-decoration: line-through;">' + it.title + ' (Qty: ' + (it.currentQty || it.quantity) + ' → Cancelled)</span><span style="font-weight: 700; color: #dc2626;">' + formatMoney(0) + '</span></div>';
                });
              } else {
                (cmItems || []).forEach(function(it) {
                  var q = it.currentQty || it.quantity;
                  var p = it.currentPrice !== undefined ? it.currentPrice : it.unitPrice;
                  html += '<div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px;"><span>' + it.title + ' (Qty: ' + q + ')</span><span style="font-weight: 600;">' + formatMoney(q * p) + '</span></div>';
                });
              }
              listEl.innerHTML = html;
            }
          }

          function updateDonePageDetails() {
            var origTotalEl = document.getElementById('cm-done-orig-total');
            var changesValEl = document.getElementById('cm-done-changes-val');
            var newTotalEl = document.getElementById('cm-done-new-total');
            var listEl = document.getElementById('cm-updated-items-list');
            var badgeEl = document.getElementById('cm-changes-count-badge');

            var diff = cmDifference || 0;
            var newTot = Math.max(0, cmOrderTotal + diff);

            if (origTotalEl) origTotalEl.innerText = formatMoney(cmOrderTotal);
            if (changesValEl) {
              if (diff > 0) {
                changesValEl.innerText = '+ ' + formatMoney(diff);
                changesValEl.style.color = '#008060';
              } else if (diff < 0) {
                changesValEl.innerText = '- ' + formatMoney(Math.abs(diff));
                changesValEl.style.color = '#dc2626';
              } else {
                changesValEl.innerText = formatMoney(0);
                changesValEl.style.color = '#64748b';
              }
            }
            if (newTotalEl) newTotalEl.innerText = formatMoney(newTot);

            // Build itemized updated list
            var fnEl = document.getElementById('cm-in-fname');
            var lnEl = document.getElementById('cm-in-lname');
            var nmEl = document.getElementById('cm-in-name');
            var a1El = document.getElementById('cm-in-a1');
            var a2El = document.getElementById('cm-in-a2');
            var cityEl = document.getElementById('cm-in-city');
            var provEl = document.getElementById('cm-in-prov');
            var zipEl = document.getElementById('cm-in-zip');

            var curFname = (fnEl ? fnEl.value : '').trim();
            var curLname = (lnEl ? lnEl.value : '').trim();
            var curA1 = (a1El ? a1El.value : '').trim();
            var curA2 = (a2El ? a2El.value : '').trim();
            var curCity = (cityEl ? cityEl.value : '').trim();
            var curProv = (provEl ? provEl.value : '').trim();
            var curZip = (zipEl ? zipEl.value : '').trim();

            var addrStr = curA1
              ? (curA1 + (curA2 ? ', ' + curA2 : '') + ', ' + curCity + (curProv ? ', ' + curProv : '') + (curZip ? ' ' + curZip : ''))
              : (${JSON.stringify(address1 ? `${address1}${address2 ? `, ${address2}` : ""}, ${city}, ${province || zip}` : "Confirmed shipping address")});

            var changesList = [];

            if (cmActiveTab === 'cancel') {
              changesList.push({
                icon: '❌',
                title: 'Order Cancellation',
                sub: 'All items in this order have been cancelled and refunded (' + formatMoney(cmOrderTotal) + ').',
                badge: 'Cancelled'
              });
            } else {
              var origA1 = ${JSON.stringify(address1)};
              var origCity = ${JSON.stringify(city)};
              if (curA1 && (curA1 !== origA1 || curCity !== origCity || cmActiveTab === 'address')) {
                changesList.push({
                  icon: '📍',
                  title: 'Shipping address',
                  sub: 'Updated to ' + addrStr,
                  badge: 'Updated'
                });
              }

              (cmItems || []).forEach(function(it) {
                if (it.currentQty && it.currentQty !== it.quantity) {
                  changesList.push({
                    icon: '#',
                    title: 'Quantity for ' + it.title,
                    sub: 'Changed from ' + it.quantity + ' to ' + it.currentQty,
                    badge: 'Updated'
                  });
                } else if (it.selectedVarId && it.selectedVarId !== (it.variant ? it.variant.id : '')) {
                  var vObj = (it.availableVariants || []).find(function(v) { return v.id === it.selectedVarId; });
                  changesList.push({
                    icon: '📦',
                    title: 'Variant for ' + it.title,
                    sub: 'Changed to ' + (vObj ? vObj.title : 'New Variant'),
                    badge: 'Updated'
                  });
                }
              });
            }

            if (changesList.length === 0) {
              changesList.push({
                icon: '📍',
                title: 'Shipping address',
                sub: 'Updated to ' + addrStr,
                badge: 'Updated'
              });
              if (cmItems && cmItems.length > 0) {
                changesList.push({
                  icon: '#',
                  title: 'Quantity for ' + cmItems[0].title,
                  sub: 'Updated to ' + (cmItems[0].currentQty || cmItems[0].quantity),
                  badge: 'Updated'
                });
              }
            }

            if (badgeEl) {
              badgeEl.innerText = changesList.length + (changesList.length === 1 ? ' change' : ' changes');
            }

            if (listEl) {
              var html = '';
              changesList.forEach(function(item) {
                html += '<div class="cm-updated-item">' +
                  '<div class="cm-updated-item-left">' +
                    '<div class="cm-updated-item-icon">' + item.icon + '</div>' +
                    '<div>' +
                      '<div class="cm-updated-item-title">' + item.title + '</div>' +
                      '<div class="cm-updated-item-sub">' + item.sub + '</div>' +
                    '</div>' +
                  '</div>' +
                  '<span class="cm-badge-pill-updated">' + item.badge + '</span>' +
                '</div>';
              });
              listEl.innerHTML = html;
            }
          }

          var isDetailsOpen = false;
          window.cmToggleDetails = function() {
            var drawer = document.getElementById('cm-order-details-drawer');
            var textEl = document.getElementById('cm-toggle-details-text');
            if (drawer) {
              isDetailsOpen = !isDetailsOpen;
              drawer.style.display = isDetailsOpen ? 'block' : 'none';
              if (textEl) {
                textEl.innerText = isDetailsOpen ? 'Hide updated order details' : 'View updated order details';
              }
            }
          };

          function startPaymentPolling() {
            if (cmPaymentPollTimer) clearInterval(cmPaymentPollTimer);
            cmPaymentPollTimer = setInterval(function() {
              window.cmVerifyPayment(true);
            }, 3000);
          }

          window.cmCommit = function() {
            var btn = document.getElementById('cm-save-btn');
            var err = document.getElementById('cm-err-box');
            if (btn) {
              btn.disabled = true;
              btn.innerText = (cmDifference > 0)
                ? 'Securing order changes & preparing checkout...'
                : 'Syncing changes with Shopify...';
            }
            if (err) err.style.display = 'none';

            var payload = buildPayload(cmActiveTab === 'cancel');
            var path = '/api/customer/edit/' + encodeURIComponent(cmToken) + '/commit';

            cmFetchApi(path, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
              },
              body: JSON.stringify(payload)
            })
            .then(function(r) {
              return r.text().then(function(text) {
                try {
                  var json = JSON.parse(text);
                  return { ok: r.ok, data: json };
                } catch(e) {
                  return { ok: false, data: { error: text || 'Server returned unexpected response.' } };
                }
              });
            })
            .then(function(res) {
              if (!res.ok) throw new Error(res.data.error || 'Failed to save changes.');

              if (res.data.status === 'PAYMENT_REQUIRED') {
                var diffVal = parseFloat(res.data.amountDue || res.data.difference || 0);
                var payUrl = res.data.paymentUrl;
                cmDifference = diffVal;

                var step5Title = document.getElementById('cm-done-title');
                var step5Sub = document.getElementById('cm-done-sub');
                var directPayBox = document.getElementById('cm-step5-direct-pay-box');
                var directPayBtn = document.getElementById('cm-step5-direct-pay-btn');

                if (step5Title) step5Title.innerText = payUrl ? 'Redirecting to Shopify Checkout...' : 'Payment Required';
                if (step5Sub) step5Sub.innerText = 'Your order changes have been saved. Complete payment of +' + formatMoney(diffVal) + ' via Shopify Checkout.';

                if (payUrl) {
                  cmInitialPaymentUrl = payUrl;
                  if (directPayBox) directPayBox.style.display = 'block';
                  if (directPayBtn) {
                    directPayBtn.href = payUrl;
                    directPayBtn.innerText = '🔒 Pay +' + formatMoney(diffVal) + ' on Shopify Checkout →';
                  }
                }

                startPaymentPolling();

                // Direct Redirect to Shopify Checkout if paymentUrl is present
                if (payUrl) {
                  var overlay = document.getElementById('cm-redirect-overlay');
                  if (overlay) overlay.style.display = 'flex';

                  if (btn) btn.innerText = '🔒 Redirecting to Shopify Checkout...';

                  setTimeout(function() {
                    try {
                      if (window.top && window.top !== window) {
                        window.top.location.href = payUrl;
                      } else {
                        window.location.href = payUrl;
                      }
                    } catch (e) {
                      window.location.href = payUrl;
                    }
                  }, 350);

                  setTimeout(function() {
                    window.cmGoTo(5);
                  }, 1000);
                } else {
                  window.cmGoTo(5);
                }
                return;
              }

              if (res.data.refundAmount) {
                var step5Title = document.getElementById('cm-done-title');
                var step5Sub = document.getElementById('cm-done-sub');
                cmDifference = -parseFloat(res.data.refundAmount);

                if (step5Title) step5Title.innerText = 'Order Updated & Refund Issued!';
                if (step5Sub) step5Sub.innerText = 'Your order has been updated and a refund of ' + formatMoney(Math.abs(cmDifference)) + ' has been issued to your payment method.';
              }

              cmIsCompleted = true;
              window.cmGoTo(5);
            })
            .catch(function(e) {
              if (btn) {
                btn.disabled = false;
                btn.innerText = (cmDifference > 0)
                  ? '🔒 Proceed to Checkout (+' + formatMoney(cmDifference) + ') →'
                  : (cmDifference < 0 ? '💰 Confirm Changes & Receive Refund' : '✓ Confirm Order Changes');
              }
              var safeMsg = sanitizeErrorMessage(e && e.message ? e.message : '');
              if (err) {
                err.innerText = '⚠️ ' + safeMsg;
                err.style.display = 'block';
                try { err.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch(ignore) {}
              }
            });
          };

          function sanitizeErrorMessage(msg) {
            if (!msg || typeof msg !== 'string') {
              return 'We were unable to process your changes right now. Please try again or contact store support.';
            }

            var lower = msg.toLowerCase();
            if (lower.includes('window has expired') || lower.includes('window closed') || lower.includes('editing window')) {
              return 'The order editing window has closed for this order.';
            }
            if (lower.includes('session was not found') || lower.includes('session not found')) {
              return 'Order edit session could not be found or has expired. Please check your order link.';
            }
            if (lower.includes('already completed')) {
              return 'This order has already been updated.';
            }
            if (lower.includes('fulfilled') || lower.includes('partially_fulfilled')) {
              return 'This order has already been fulfilled and can no longer be edited.';
            }
            if (lower.includes('already cancelled') || lower.includes('already canceled')) {
              return 'This order has already been cancelled.';
            }
            if (lower.includes('permission') || lower.includes('disabled by merchant')) {
              return 'This edit action is currently not permitted for this order.';
            }
            if (lower.includes('out of stock') || lower.includes('inventory')) {
              return 'One or more items in your request are currently out of stock.';
            }

            // Hide raw technical error traces / GraphQL details / server internal messages
            if (
              lower.includes('graphql') ||
              lower.includes('shopify') ||
              lower.includes('error:') ||
              lower.includes('exception') ||
              lower.includes('syntax') ||
              lower.includes('mutation') ||
              lower.includes('prisma') ||
              lower.includes('database') ||
              lower.includes('sql') ||
              lower.includes('fetch') ||
              lower.includes('undefined') ||
              lower.includes('null') ||
              lower.includes('failed to execute') ||
              lower.includes('unexpected') ||
              lower.includes('500') ||
              lower.includes('404') ||
              lower.includes('econnrefused')
            ) {
              return 'We were unable to save your changes right now. Please try again or contact store support.';
            }

            return msg;
          }

          window.cmVerifyPayment = function(isSilent) {
            var path = '/api/customer/edit/' + encodeURIComponent(cmToken) + '/payment/verify';
            cmFetchApi(path, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
            })
            .then(function(r) { return r.json(); })
            .then(function(res) {
              if (res && res.verified) {
                if (cmPaymentPollTimer) clearInterval(cmPaymentPollTimer);
                cmIsCompleted = true;
                var step5Title = document.getElementById('cm-done-title');
                var step5Sub = document.getElementById('cm-done-sub');
                var directPayBox = document.getElementById('cm-step5-direct-pay-box');
                var overlay = document.getElementById('cm-redirect-overlay');

                if (overlay) overlay.style.display = 'none';
                if (step5Title) step5Title.innerText = 'Your order has been updated!';
                if (step5Sub) step5Sub.innerText = 'Shopify has confirmed your payment. Your order edits are complete!';
                if (directPayBox) directPayBox.style.display = 'none';
                updateDonePageDetails();
              } else if (!isSilent) {
                alert(res.message || 'Payment is still processing on Shopify. Please complete checkout or try again.');
              }
            })
            .catch(function(e) {
              if (!isSilent) alert('We could not verify payment status at this moment. Please refresh the page or check back shortly.');
            });
          };

          // Initialize state if already completed, returned from payment, or awaiting payment
          if (cmIsCompleted || ${isPaymentReturn ? "true" : "false"}) {
            cmIsCompleted = true;
            window.cmGoTo(5);
            if (${isPaymentReturn ? "true" : "false"}) {
              window.cmVerifyPayment(true);
            }
          } else if (cmInitialStatus === 'PAYMENT_REQUIRED') {
            var step5Title = document.getElementById('cm-done-title');
            var step5Sub = document.getElementById('cm-done-sub');
            var directPayBox = document.getElementById('cm-step5-direct-pay-box');
            var directPayBtn = document.getElementById('cm-step5-direct-pay-btn');

            if (step5Title) step5Title.innerText = 'Payment Required to Complete Order';
            if (step5Sub) step5Sub.innerText = 'Please complete the additional payment on Shopify Checkout.';
            if (cmInitialPaymentUrl && directPayBox && directPayBtn) {
              directPayBox.style.display = 'block';
              directPayBtn.href = cmInitialPaymentUrl;
            }
            window.cmGoTo(5);
            startPaymentPolling();
          }

          // Event delegation
          document.addEventListener('click', function(e) {
            var target = e.target;
            if (!target) return;

            var gotoBtn = target.closest('.cm-btn-goto');
            if (gotoBtn) {
              e.preventDefault();
              var stepNum = parseInt(gotoBtn.getAttribute('data-goto'), 10);
              if (stepNum && window.cmGoTo) window.cmGoTo(stepNum);
              return;
            }

            var tabBtn = target.closest('.cm-tab-btn');
            if (tabBtn) {
              e.preventDefault();
              var tabName = tabBtn.getAttribute('data-tab');
              if (tabName && window.cmSetTab) window.cmSetTab(tabName);
              return;
            }

            var qtyBtn = target.closest('.cm-sf-qty-btn') || target.closest('.cm-qty-btn');
            if (qtyBtn) {
              e.preventDefault();
              var idx = parseInt(qtyBtn.getAttribute('data-idx'), 10);
              var delta = parseInt(qtyBtn.getAttribute('data-delta'), 10);
              if (!isNaN(idx) && !isNaN(delta) && window.cmQty) window.cmQty(idx, delta);
              return;
            }

            if (target.id === 'cm-save-btn' || target.closest('#cm-save-btn')) {
              e.preventDefault();
              window.cmCommit();
              return;
            }

            if (target.id === 'cm-toggle-details-btn' || target.closest('#cm-toggle-details-btn') || target.id === 'cm-help-view-details' || target.closest('#cm-help-view-details')) {
              e.preventDefault();
              window.cmToggleDetails();
              return;
            }

            if (target.id === 'cm-help-retry-pay' || target.closest('#cm-help-retry-pay')) {
              e.preventDefault();
              if (cmInitialPaymentUrl) {
                window.location.href = cmInitialPaymentUrl;
              } else {
                window.cmGoTo(4);
              }
              return;
            }
          });

          document.addEventListener('change', function(e) {
            if (e.target && e.target.classList.contains('cm-var-select')) {
              var idx = parseInt(e.target.getAttribute('data-idx'), 10);
              if (!isNaN(idx) && window.cmVar) window.cmVar(idx, e.target);
            }
          });

        })();
      </script>
    </body>
    </html>
  `;
}
