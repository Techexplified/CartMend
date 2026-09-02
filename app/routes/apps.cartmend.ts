import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const search = url.searchParams.toString();
  const accept = request.headers.get("accept") || "";

  // Always redirect browser and admin navigations to the Dashboard (/app)
  if (
    accept.includes("text/html") ||
    url.searchParams.has("shop") ||
    url.searchParams.has("host") ||
    url.searchParams.has("embedded") ||
    url.searchParams.has("id_token") ||
    !accept.includes("application/json")
  ) {
    return redirect(search ? `/app?${search}` : `/app`);
  }

  return new Response("CartMend App Proxy Active", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
