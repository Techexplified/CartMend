import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const searchParams = url.searchParams.toString();
  return redirect(searchParams ? `/app?${searchParams}` : "/app");
};

export default function Index() {
  return null;
}

