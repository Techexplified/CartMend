import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { OrderEditPaymentService } from "../services/order-edit-payment.server";
import { DomainError } from "../services/errors";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, X-Requested-With",
};

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const rawToken = params.token ? decodeURIComponent(params.token).trim() : "";
  if (!rawToken) {
    return Response.json({ error: "Missing customer edit token" }, { status: 400, headers: CORS_HEADERS });
  }

  try {
    const result = await OrderEditPaymentService.verifyPayment(rawToken);
    return Response.json(result, { headers: CORS_HEADERS });
  } catch (error: any) {
    if (error instanceof DomainError) {
      return Response.json(
        { error: error.message, code: error.name },
        { status: error.statusCode, headers: CORS_HEADERS }
      );
    }
    console.error("[CartMend Payment Verify Loader Error]:", error);
    return Response.json(
      { error: "Unable to verify payment status at this moment." },
      { status: 500, headers: CORS_HEADERS }
    );
  }
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const rawToken = params.token ? decodeURIComponent(params.token).trim() : "";
  if (!rawToken) {
    return Response.json({ error: "Missing customer edit token" }, { status: 400, headers: CORS_HEADERS });
  }

  try {
    const result = await OrderEditPaymentService.verifyPayment(rawToken);
    return Response.json(result, { headers: CORS_HEADERS });
  } catch (error: any) {
    if (error instanceof DomainError) {
      return Response.json(
        { error: error.message, code: error.name },
        { status: error.statusCode, headers: CORS_HEADERS }
      );
    }
    console.error("[CartMend Payment Verify Action Error]:", error);
    return Response.json(
      { error: "Unable to verify payment status at this moment." },
      { status: 500, headers: CORS_HEADERS }
    );
  }
};
