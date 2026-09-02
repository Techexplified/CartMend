import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getEditableOrderDetails, commitOrderEdit } from "../services/order-edit.server";
import { DomainError } from "../services/errors";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, X-Requested-With, x-shopify-shop-domain",
};

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  const rawToken = params.token ? decodeURIComponent(params.token).trim() : "";

  if (!rawToken) {
    return Response.json({ error: "Missing customer edit token" }, { status: 400, headers: CORS_HEADERS });
  }

  try {
    const data = await getEditableOrderDetails(rawToken);
    return Response.json(data, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        ...CORS_HEADERS,
      },
    });
  } catch (error: any) {
    if (error instanceof DomainError) {
      return Response.json(
        { error: error.message, code: error.name },
        {
          status: error.statusCode,
          headers: CORS_HEADERS,
        }
      );
    }

    return Response.json(
      { error: error.message || "An unexpected error occurred while retrieving order." },
      {
        status: 500,
        headers: CORS_HEADERS,
      }
    );
  }
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  const rawToken = params.token ? decodeURIComponent(params.token).trim() : "";

  if (!rawToken) {
    return Response.json({ error: "Missing customer edit token" }, { status: 400, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: CORS_HEADERS });
  }

  try {
    let body: any = {};
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      body = await request.json().catch(() => ({}));
    } else if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const payloadStr = formData.get("payload");
      if (typeof payloadStr === "string") {
        body = JSON.parse(payloadStr);
      }
    } else {
      const text = await request.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }

    const result = await commitOrderEdit(rawToken, body);
    return Response.json(result, {
      headers: CORS_HEADERS,
    });
  } catch (error: any) {
    if (error instanceof DomainError) {
      return Response.json(
        { error: error.message, code: error.name },
        {
          status: error.statusCode,
          headers: CORS_HEADERS,
        }
      );
    }

    console.error("[CartMend Order Commit Action Error]:", error);

    return Response.json(
      { error: "We were unable to save your changes right now. Please try again or contact store support." },
      {
        status: 500,
        headers: CORS_HEADERS,
      }
    );
  }
};
