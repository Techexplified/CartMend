import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { PostPurchaseActionService } from "../services/post-purchase-action.server";
import prisma from "../db.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, X-Requested-With, x-shopify-shop-domain",
};

function renderRedirectHtml(targetUrl: string, title = "Opening CartMend...") {
  return `{% layout none %}
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="0; url=${targetUrl}">
  <title>${title}</title>
  <script>
    window.location.replace("${targetUrl}");
  </script>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f8fafc;
      margin: 0;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 80vh;
    }
    .cm-redirect-card {
      background: #ffffff;
      padding: 32px 28px;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);
      text-align: center;
      max-width: 380px;
      width: 90%;
    }
    .cm-spinner {
      width: 36px;
      height: 36px;
      border: 3px solid #e2e8f0;
      border-top-color: #0f172a;
      border-radius: 50%;
      animation: cmSpin 0.8s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes cmSpin {
      to { transform: rotate(360deg); }
    }
    h3 {
      margin: 0 0 8px;
      color: #0f172a;
      font-size: 17px;
      font-weight: 600;
    }
    p {
      margin: 0 0 16px;
      color: #64748b;
      font-size: 13px;
      line-height: 1.4;
    }
    a {
      color: #2563eb;
      font-size: 13px;
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="cm-redirect-card">
    <div class="cm-spinner"></div>
    <h3>Opening Order Editor...</h3>
    <p>Please wait while we securely prepare your order details.</p>
    <a href="${targetUrl}">Click here if not redirected automatically</a>
  </div>
</body>
</html>`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);

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

  const isJsonRequest = request.headers.get("accept")?.includes("application/json") || url.searchParams.get("format") === "json";
  let shopDomain = request.headers.get("x-shopify-shop-domain") || url.searchParams.get("shop") || "";
  let shopifyOrderId = url.searchParams.get("order_id") || url.searchParams.get("orderId") || url.searchParams.get("id") || "";

  if (!shopDomain) {
    const cleanNum = String(shopifyOrderId).replace(/\D/g, "");
    if (cleanNum) {
      const matchedOrder = await prisma.order.findFirst({
        where: { shopifyOrderId: cleanNum },
        include: { shop: true },
      });
      if (matchedOrder?.shop?.shopDomain) {
        shopDomain = matchedOrder.shop.shopDomain;
      }
    }
  }

  if (!shopDomain) {
    const firstShop = await prisma.shop.findFirst({ where: { uninstalledAt: null } });
    if (firstShop) shopDomain = firstShop.shopDomain;
  }

  const cleanDomain = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");

  try {
    const sessionResult = await PostPurchaseActionService.createOrRetrieveEditSession(
      cleanDomain,
      String(shopifyOrderId || "")
    );

    const redirectPath = sessionResult?.redirectUrl || `/apps/cartmend/edit/preview`;
    const finalTarget = redirectPath.startsWith("http")
      ? redirectPath
      : `https://${cleanDomain}${redirectPath}`;

    if (isJsonRequest) {
      return Response.json(sessionResult, { headers: CORS_HEADERS });
    }

    // Always respond with Status 200 application/liquid for Storefront App Proxy browser navigations
    const html = renderRedirectHtml(finalTarget, "Opening CartMend Edit Order...");
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "application/liquid; charset=utf-8",
        ...CORS_HEADERS,
      },
    });
  } catch (error: any) {
    console.error("[CartMend App Proxy Post-Purchase Edit Session Error]:", error);

    if (isJsonRequest) {
      return Response.json({ error: error.message || "Failed to create edit session" }, { status: 400, headers: CORS_HEADERS });
    }

    const fallbackUrl = `https://${cleanDomain}/apps/cartmend/edit/preview`;
    const html = renderRedirectHtml(fallbackUrl, "Opening CartMend Edit Order...");
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "application/liquid; charset=utf-8",
        ...CORS_HEADERS,
      },
    });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    let shopDomain =
      body.shopDomain ||
      body.shop ||
      request.headers.get("x-shopify-shop-domain") ||
      url.searchParams.get("shop") ||
      "";
    let shopifyOrderId =
      body.shopifyOrderId ||
      body.orderId ||
      url.searchParams.get("order_id") ||
      url.searchParams.get("id") ||
      "";

    if (!shopDomain) {
      const cleanNum = String(shopifyOrderId).replace(/\D/g, "");
      if (cleanNum) {
        const matchedOrder = await prisma.order.findFirst({
          where: { shopifyOrderId: cleanNum },
          include: { shop: true },
        });
        if (matchedOrder?.shop?.shopDomain) {
          shopDomain = matchedOrder.shop.shopDomain;
        }
      }
    }

    if (!shopDomain) {
      const firstShop = await prisma.shop.findFirst({ where: { uninstalledAt: null } });
      if (firstShop) shopDomain = firstShop.shopDomain;
    }

    const cleanDomain = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");

    const sessionResult = await PostPurchaseActionService.createOrRetrieveEditSession(
      cleanDomain,
      String(shopifyOrderId || "")
    );

    return Response.json(
      {
        success: true,
        redirectUrl: sessionResult.redirectUrl,
        expiresAt: sessionResult.expiresAt,
        remainingSeconds: sessionResult.remainingSeconds,
      },
      {
        status: 200,
        headers: CORS_HEADERS,
      }
    );
  } catch (error: any) {
    console.error("[CartMend App Proxy Post-Purchase Edit Session Error]:", error);
    return Response.json(
      { error: error.message || "Failed to create edit session" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
