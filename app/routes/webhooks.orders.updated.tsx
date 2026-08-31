import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processShopifyWebhook } from "../services/webhook-processor.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic, webhookId } = await authenticate.webhook(request);

  try {
    await processShopifyWebhook({
      shopDomain: shop,
      topic: topic || "orders/updated",
      shopifyWebhookId: webhookId || null,
      payload: payload as Record<string, any>,
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error(`[CartMend Webhook Error: ${topic}]`, error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
};
