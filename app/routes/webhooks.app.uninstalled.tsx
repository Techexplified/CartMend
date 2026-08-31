import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processShopifyWebhook } from "../services/webhook-processor.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic, webhookId, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    await processShopifyWebhook({
      shopDomain: shop,
      topic: topic || "app/uninstalled",
      shopifyWebhookId: webhookId || null,
      payload: (payload as Record<string, any>) || {},
    });
  } catch (error) {
    console.error(`[CartMend app/uninstalled error]`, error);
  }

  return new Response();
};
