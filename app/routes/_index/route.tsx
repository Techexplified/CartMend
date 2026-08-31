import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // If request contains any Shopify embedded/OAuth parameters (host, shop, embedded, id_token, session),
  // forward immediately to /app for seamless App Bridge & token-exchange authentication.
  if (
    url.searchParams.get("shop") ||
    url.searchParams.get("host") ||
    url.searchParams.get("id_token") ||
    url.searchParams.get("embedded") ||
    url.searchParams.get("session") ||
    url.searchParams.toString() !== ""
  ) {
    return redirect(`/app?${url.searchParams.toString()}`);
  }

  // Standalone visits without any Shopify parameters redirect to login
  return redirect("/auth/login");
};

export default function Index() {
  return null;
}


