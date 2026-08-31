import type { LoaderFunctionArgs } from "react-router";
import { OrderEditPaymentService } from "../services/order-edit-payment.server";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const token = params.token;
  if (!token) {
    return new Response("Missing token", { status: 400 });
  }

  // Attempt server-side verification upon customer returning
  try {
    await OrderEditPaymentService.verifyPayment(token);
  } catch (err) {
    console.warn("[CartMend Payment Return] Non-fatal verification check:", err);
  }

  // Redirect back to the App Proxy customer editor
  return Response.redirect(`/apps/cartmend/edit/${token}?payment_return=1`, 302);
};
