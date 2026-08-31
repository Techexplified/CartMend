import { useState, useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { getMerchantSettings } from "../services/merchant-settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  let theme = "Light";
  try {
    const settings = await getMerchantSettings(session.shop);
    theme = (settings as any)?.theme || "Light";
  } catch (err) {
    console.warn("[CartMend] Could not query theme in app.tsx loader:", err);
  }

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "d17227215824c8a4d33087ec24a42d70",
    theme,
  };
};

export default function App() {
  const { apiKey, theme } = useLoaderData<typeof loader>();
  const [currentTheme, setCurrentTheme] = useState(theme);

  useEffect(() => {
    setCurrentTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    const isDark =
      currentTheme === "Dark" ||
      (currentTheme === "System" &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);

    if (isDark) {
      root.classList.add("dark");
      root.setAttribute("data-theme", "dark");
      document.body.classList.add("dark");
      document.body.setAttribute("data-theme", "dark");
    } else {
      root.classList.remove("dark");
      root.setAttribute("data-theme", "light");
      document.body.classList.remove("dark");
      document.body.setAttribute("data-theme", "light");
    }
  }, [currentTheme]);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <div
        className={`cm-app-theme-root ${currentTheme === "Dark" ? "dark" : ""}`}
        data-theme={currentTheme.toLowerCase()}
      >
        <s-app-nav>
          <s-link href="/app">Dashboard</s-link>
          <s-link href="/app/order-activity">Order Activity</s-link>
          <s-link href="/app/editing-rules">Editing Rules</s-link>
          <s-link href="/app/settings">Settings</s-link>
        </s-app-nav>
        <Outlet />
      </div>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

