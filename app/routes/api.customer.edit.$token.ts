import type { LoaderFunctionArgs } from "react-router";
import { getEditableOrderDetails } from "../services/order-edit.server";
import { DomainError } from "../services/errors";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const token = params.token;

  if (!token) {
    return Response.json({ error: "Missing customer edit token" }, { status: 400 });
  }

  try {
    const data = await getEditableOrderDetails(token);
    return Response.json(data, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error: any) {
    if (error instanceof DomainError) {
      return Response.json(
        { error: error.message, code: error.name },
        {
          status: error.statusCode,
          headers: {
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    return Response.json(
      { error: error.message || "An unexpected error occurred while retrieving order." },
      {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
};
