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
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }
  return Response.json({ status: "ok" }, { headers: CORS_HEADERS });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  try {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    const shopifyOrderId = body.shopifyOrderId || body.orderId || url.searchParams.get("orderId");
    let shopDomain =
      body.shopDomain ||
      body.shop ||
      request.headers.get("x-shopify-shop-domain") ||
      url.searchParams.get("shop");

    if (!shopifyOrderId) {
      return Response.json(
        { error: "Missing required parameter: shopifyOrderId" },
        {
          status: 400,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json",
          },
        }
      );
    }

    // If shopDomain not explicitly provided, look up by order in database
    if (!shopDomain) {
      const cleanNum = String(shopifyOrderId).replace(/\D/g, "");
      const matchedOrder = await prisma.order.findFirst({
        where: { shopifyOrderId: cleanNum },
        include: { shop: true },
      });
      if (matchedOrder?.shop?.shopDomain) {
        shopDomain = matchedOrder.shop.shopDomain;
      }
    }

    if (!shopDomain) {
      // Fallback: check first active shop
      const firstShop = await prisma.shop.findFirst({
        where: { uninstalledAt: null },
      });
      if (firstShop) {
        shopDomain = firstShop.shopDomain;
      }
    }

    if (!shopDomain) {
      return Response.json(
        { error: "Could not identify shop for this request." },
        {
          status: 400,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json",
          },
        }
      );
    }

    const result = await PostPurchaseActionService.getAvailableActions(shopDomain, shopifyOrderId);

    return Response.json(result, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      },
    });
  } catch (error: any) {
    console.error("[CartMend] post-purchase/actions error:", error);
    return Response.json(
      { error: error.message || "Failed to determine available actions." },
      {
        status: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        },
      }
    );
  }
}
