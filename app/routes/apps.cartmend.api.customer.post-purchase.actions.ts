import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { PostPurchaseActionService } from "../services/post-purchase-action.server";
import prisma from "../db.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, X-Requested-With, x-shopify-shop-domain",
};

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return Response.json({ status: "ok" }, { headers: CORS_HEADERS });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await request.json().catch(() => ({}));
    let { shopDomain, shopifyOrderId } = body;

    const url = new URL(request.url);
    if (!shopDomain) {
      shopDomain = request.headers.get("x-shopify-shop-domain") || url.searchParams.get("shop") || "";
    }
    if (!shopifyOrderId) {
      shopifyOrderId = url.searchParams.get("order_id") || url.searchParams.get("id") || "";
    }

    let cleanDomain = shopDomain ? shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "") : "";

    if (!cleanDomain) {
      const firstShop = await prisma.shop.findFirst({ where: { uninstalledAt: null } });
      if (firstShop) cleanDomain = firstShop.shopDomain;
    }

    const actions = await PostPurchaseActionService.getAvailableActions(cleanDomain, String(shopifyOrderId || "preview"));

    return Response.json(actions, {
      status: 200,
      headers: CORS_HEADERS,
    });
  } catch (error: any) {
    console.error("[CartMend App Proxy Post-Purchase Actions Error]:", error);
    return Response.json(
      { error: error.message || "Failed to retrieve available actions" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
