import { useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const search = url.searchParams.toString();
  return redirect(search ? `/app?${search}` : `/app`);
};

export default function Index() {
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.location.replace(`/app${window.location.search}`);
    }
  }, []);

  return null;
}

