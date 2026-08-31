import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (shop) {
    return redirect(`/app?${url.searchParams.toString()}`);
  }

  return redirect("/auth/login");
};

export default function Index() {
  return null;
}


