import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return new Response("CartMend App Proxy Active", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
