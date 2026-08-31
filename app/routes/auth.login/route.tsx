import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const host = url.searchParams.get("host");

  if (shop || host) {
    return redirect(`/app?${url.searchParams.toString()}`);
  }

  return redirect("/");
};

export default function Auth() {
  return null;
}
