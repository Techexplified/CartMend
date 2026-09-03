import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processShopifyWebhook } from "../services/webhook-processor.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic, webhookId } = await authenticate.webhook(request);

  console.log(`[CartMend Compliance] Received ${topic} for ${shop}`);

  try {
    await processShopifyWebhook({
      shopDomain: shop,
      topic: topic || "customers/redact",
      shopifyWebhookId: webhookId || null,
      payload: (payload as Record<string, any>) || {},
    });
  } catch (error) {
    console.error("[CartMend customers/redact error]:", error);
  }

  return new Response();
};
