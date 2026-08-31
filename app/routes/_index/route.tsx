import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData } from "react-router";
import { login } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const host = url.searchParams.get("host");
  const embedded = url.searchParams.get("embedded");
  const idToken = url.searchParams.get("id_token");
  const session = url.searchParams.get("session");

  // If this request originates from Shopify Admin (has shop, host, embedded, or session token),
  // forward immediately to the embedded /app layout without showing the public landing page.
  if (shop || host || embedded || idToken || session) {
    return redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return await login(request);
};

export default function Index() {
  const actionData = useActionData<{ shop?: string }>();
  const [shopInput, setShopInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <div style={styles.container}>
      <div style={styles.backgroundGlow} />

      {/* Navigation Header */}
      <header style={styles.header}>
        <div style={styles.brand}>
          <div style={styles.logoBadge}>
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#6366f1"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <path d="M16 10a4 4 0 0 1-8 0" />
            </svg>
          </div>
          <span style={styles.brandTitle}>CartMend</span>
          <span style={styles.versionBadge}>v2.0</span>
        </div>

        <a
          href="https://shopify.dev/docs/apps"
          target="_blank"
          rel="noopener noreferrer"
          style={styles.docLink}
        >
          Documentation ↗
        </a>
      </header>

      {/* Main Connect Card */}
      <main style={styles.main}>
        <div style={styles.card}>
          <div style={styles.iconWrapper}>
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#6366f1"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
          </div>

          <h1 style={styles.title}>Connect your Shopify store</h1>
          <p style={styles.subtitle}>
            Enter your <strong>.myshopify.com</strong> domain to install or sign in to CartMend.
          </p>

          <Form
            method="post"
            style={styles.form}
            onSubmit={() => setIsSubmitting(true)}
          >
            <div style={styles.inputGroup}>
              <label htmlFor="shop" style={styles.label}>
                Store Domain
              </label>
              <div style={styles.inputWrapper}>
                <input
                  id="shop"
                  name="shop"
                  type="text"
                  placeholder="your-store-name.myshopify.com"
                  value={shopInput}
                  onChange={(e) => setShopInput(e.target.value)}
                  style={styles.input}
                  required
                  autoComplete="off"
                  autoFocus
                />
              </div>
              {actionData?.shop && (
                <p style={styles.errorText}>Please enter a valid Shopify store domain.</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !shopInput.trim()}
              style={{
                ...styles.button,
                opacity: isSubmitting || !shopInput.trim() ? 0.7 : 1,
                cursor: isSubmitting || !shopInput.trim() ? "not-allowed" : "pointer",
              }}
            >
              {isSubmitting ? (
                <span>Connecting to Shopify...</span>
              ) : (
                <span>Install / Log In to App →</span>
              )}
            </button>
          </Form>

          {/* Quick info badges */}
          <div style={styles.featuresGrid}>
            <div style={styles.featureItem}>
              <span style={styles.featureIcon}>⚡</span>
              <div>
                <strong style={styles.featureHeading}>Self-Serve Editing</strong>
                <p style={styles.featureDesc}>Customers can modify items, sizes, or addresses post-purchase.</p>
              </div>
            </div>

            <div style={styles.featureItem}>
              <span style={styles.featureIcon}>💳</span>
              <div>
                <strong style={styles.featureHeading}>Automated Payments & Refunds</strong>
                <p style={styles.featureDesc}>Automatic Shopify invoice generation and difference refunds.</p>
              </div>
            </div>

            <div style={styles.featureItem}>
              <span style={styles.featureIcon}>⏱</span>
              <div>
                <strong style={styles.featureHeading}>Full Merchant Control</strong>
                <p style={styles.featureDesc}>Time-bounded windows and item restrictions.</p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer style={styles.footer}>
        <p>© 2026 CartMend. Built for high-growth Shopify stores.</p>
      </footer>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    backgroundColor: "#090d16",
    color: "#f3f4f6",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    display: "flex",
    flexDirection: "column",
    position: "relative",
    overflow: "hidden",
  },
  backgroundGlow: {
    position: "absolute",
    top: "-20%",
    left: "50%",
    transform: "translateX(-50%)",
    width: "700px",
    height: "500px",
    background: "radial-gradient(circle, rgba(99, 102, 241, 0.15) 0%, rgba(15, 23, 42, 0) 70%)",
    pointerEvents: "none",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "20px 32px",
    zIndex: 10,
    borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  logoBadge: {
    width: "40px",
    height: "40px",
    borderRadius: "10px",
    backgroundColor: "rgba(99, 102, 241, 0.12)",
    border: "1px solid rgba(99, 102, 241, 0.3)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  brandTitle: {
    fontSize: "20px",
    fontWeight: 700,
    letterSpacing: "-0.5px",
    color: "#ffffff",
  },
  versionBadge: {
    fontSize: "11px",
    fontWeight: 600,
    color: "#818cf8",
    backgroundColor: "rgba(99, 102, 241, 0.15)",
    padding: "2px 8px",
    borderRadius: "999px",
  },
  docLink: {
    color: "#94a3b8",
    fontSize: "14px",
    textDecoration: "none",
    fontWeight: 500,
  },
  main: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 20px",
    zIndex: 10,
  },
  card: {
    width: "100%",
    maxWidth: "520px",
    backgroundColor: "rgba(17, 24, 39, 0.8)",
    backdropFilter: "blur(16px)",
    border: "1px solid rgba(255, 255, 255, 0.1)",
    borderRadius: "20px",
    padding: "40px 36px",
    boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)",
    textAlign: "center",
  },
  iconWrapper: {
    width: "64px",
    height: "64px",
    borderRadius: "16px",
    backgroundColor: "rgba(99, 102, 241, 0.12)",
    border: "1px solid rgba(99, 102, 241, 0.25)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: "20px",
  },
  title: {
    fontSize: "26px",
    fontWeight: 700,
    color: "#ffffff",
    letterSpacing: "-0.5px",
    margin: "0 0 10px 0",
  },
  subtitle: {
    fontSize: "15px",
    color: "#94a3b8",
    lineHeight: "1.5",
    margin: "0 0 28px 0",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "18px",
    textAlign: "left",
  },
  inputGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  label: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#cbd5e1",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  inputWrapper: {
    position: "relative",
  },
  input: {
    width: "100%",
    padding: "14px 16px",
    backgroundColor: "#0f172a",
    border: "1px solid rgba(255, 255, 255, 0.15)",
    borderRadius: "10px",
    color: "#ffffff",
    fontSize: "15px",
    outline: "none",
    boxSizing: "border-box",
    transition: "border-color 0.2s",
  },
  errorText: {
    color: "#f87171",
    fontSize: "13px",
    margin: "4px 0 0 0",
  },
  button: {
    width: "100%",
    padding: "15px",
    backgroundColor: "#4f46e5",
    backgroundImage: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)",
    color: "#ffffff",
    fontSize: "16px",
    fontWeight: 600,
    border: "none",
    borderRadius: "10px",
    boxShadow: "0 10px 15px -3px rgba(79, 70, 229, 0.4)",
    transition: "transform 0.1s, opacity 0.2s",
  },
  featuresGrid: {
    marginTop: "32px",
    paddingTop: "24px",
    borderTop: "1px solid rgba(255, 255, 255, 0.08)",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    textAlign: "left",
  },
  featureItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
  },
  featureIcon: {
    fontSize: "16px",
    marginTop: "2px",
  },
  featureHeading: {
    display: "block",
    fontSize: "13px",
    color: "#e2e8f0",
    marginBottom: "2px",
  },
  featureDesc: {
    fontSize: "12px",
    color: "#94a3b8",
    margin: 0,
    lineHeight: "1.4",
  },
  footer: {
    textAlign: "center",
    padding: "20px",
    color: "#64748b",
    fontSize: "13px",
    borderTop: "1px solid rgba(255, 255, 255, 0.04)",
  },
};
