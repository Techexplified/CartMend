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
    let { shopDomain, shopifyOrderId, reason, refundMethod, restock } = body;

    const url = new URL(request.url);
    if (!shopDomain) {
      shopDomain = request.headers.get("x-shopify-shop-domain") || url.searchParams.get("shop") || "";
    }
    if (!shopifyOrderId) {
      shopifyOrderId = url.searchParams.get("order_id") || url.searchParams.get("id") || "";
    }

    if (!shopDomain || !shopifyOrderId) {
      return Response.json(
        { error: "Missing required parameters: shopDomain and shopifyOrderId" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const cleanDomain = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");

    const shop = await prisma.shop.findUnique({
      where: { shopDomain: cleanDomain },
    });

    if (!shop) {
      return Response.json(
        { error: `Shop ${cleanDomain} is not registered with CartMend.` },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const cancelResult = await PostPurchaseActionService.cancelOrder(
      cleanDomain,
      String(shopifyOrderId),
      reason || "CUSTOMER"
    );

    return Response.json(cancelResult, {
      status: 200,
      headers: CORS_HEADERS,
    });
  } catch (error: any) {
    console.error("[CartMend App Proxy Post-Purchase Cancel Error]:", error);
    return Response.json(
      { error: error.message || "Failed to cancel order" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
