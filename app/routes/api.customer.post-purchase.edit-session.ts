import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { PostPurchaseActionService } from "../services/post-purchase-action.server";
import prisma from "../db.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-shopify-shop-domain",
};

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  let shopDomain = request.headers.get("x-shopify-shop-domain") || url.searchParams.get("shop") || "";
  let shopifyOrderId = url.searchParams.get("order_id") || url.searchParams.get("orderId") || url.searchParams.get("id") || "";
  const shouldRedirect = url.searchParams.get("redirect") === "1";

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

    if (shouldRedirect && sessionResult?.redirectUrl) {
      const finalTarget = sessionResult.redirectUrl.startsWith("http")
        ? sessionResult.redirectUrl
        : `https://${cleanDomain}${sessionResult.redirectUrl}`;
      return new Response(null, {
        status: 302,
        headers: {
          Location: finalTarget,
          ...CORS_HEADERS,
        },
      });
    }

    return Response.json(sessionResult, { headers: CORS_HEADERS });
  } catch (error: any) {
    if (shouldRedirect) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `https://${cleanDomain}/apps/cartmend/edit/preview`,
          ...CORS_HEADERS,
        },
      });
    }
    return Response.json({ error: error.message }, { status: 400, headers: CORS_HEADERS });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    let shopifyOrderId =
      body.shopifyOrderId ||
      body.orderId ||
      url.searchParams.get("orderId") ||
      url.searchParams.get("order_id") ||
      url.searchParams.get("id") ||
      "";
    let shopDomain =
      body.shopDomain ||
      body.shop ||
      request.headers.get("x-shopify-shop-domain") ||
      url.searchParams.get("shop") ||
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

    const result = await PostPurchaseActionService.createOrRetrieveEditSession(
      cleanDomain,
      String(shopifyOrderId || "")
    );

    return Response.json(
      {
        success: true,
        redirectUrl: result.redirectUrl,
        expiresAt: result.expiresAt,
        remainingSeconds: result.remainingSeconds,
      },
      {
        status: 200,
        headers: CORS_HEADERS,
      }
    );
  } catch (error: any) {
    console.error("[CartMend Direct Post-Purchase Edit Session Error]:", error);
    return Response.json(
      { error: error.message || "Failed to create edit session" },
      {
        status: 500,
        headers: CORS_HEADERS,
      }
    );
  }
}
