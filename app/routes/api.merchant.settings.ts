import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getMerchantSettings, updateMerchantSettings } from "../services/merchant-settings.server";
import { DomainError } from "../services/errors";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getMerchantSettings(session.shop);
  return Response.json({ success: true, settings });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  if (request.method !== "PUT" && request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await request.json();
    const settings = await updateMerchantSettings(session.shop, body);
    return Response.json({ success: true, settings, message: "Settings updated successfully." });
  } catch (error: any) {
    if (error instanceof DomainError) {
      return Response.json({ error: error.message }, { status: error.statusCode });
    }
    return Response.json(
      { error: error.message || "Failed to update merchant settings" },
      { status: 500 }
    );
  }
};
