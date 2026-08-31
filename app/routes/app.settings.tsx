import { useState, useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  getOrCreateShop,
  getMerchantSettings,
  updateMerchantSettings,
  createSupportTicket,
} from "../services/merchant-settings.server";
import { GET_SHOP_QUERY } from "../services/shopify/graphql-queries";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;

  await getOrCreateShop(shopDomain);
  const settings = await getMerchantSettings(shopDomain);

  let merchantEmail = settings.supportEmail || "";
  let shopName = "";
  try {
    const shopResponse = await admin.graphql(GET_SHOP_QUERY);
    const shopJson = (await shopResponse.json()) as any;
    if (shopJson?.data?.shop) {
      shopName = shopJson.data.shop.name || "";
      if (shopJson.data.shop.email && !merchantEmail) {
        merchantEmail = shopJson.data.shop.email;
      }
    }
  } catch (err) {
    console.warn("[CartMend] Could not query shop email:", err);
  }

  if (!merchantEmail) {
    merchantEmail = `merchant@${shopDomain}`;
  }

  const url = new URL(request.url);
  const initialSupportOpen = url.searchParams.get("contact_support") === "1" || url.searchParams.get("support") === "open";

  return {
    shopDomain,
    shopName,
    merchantEmail,
    settings: {
      sendEditLinkEmail: settings.sendEditLinkEmail ?? true,
      notifyCustomer: settings.notifyCustomer ?? true,
      sendPaymentRefundEmails: (settings as any).sendPaymentRefundEmails ?? true,
      theme: (settings as any).theme || "Light",
      supportEmail: settings.supportEmail || merchantEmail,
    },
    initialSupportOpen,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "save_settings") {
    const sendEditLinkEmail = formData.get("sendEditLinkEmail") === "true";
    const notifyCustomer = formData.get("notifyCustomer") === "true";
    const sendPaymentRefundEmails = formData.get("sendPaymentRefundEmails") === "true";
    const theme = String(formData.get("theme") || "Light");

    await updateMerchantSettings(session.shop, {
      sendEditLinkEmail,
      notifyCustomer,
      sendPaymentRefundEmails,
      theme,
    });

    return {
      success: true,
      intent: "save_settings",
      message: "Settings saved successfully!",
    };
  }

  if (intent === "contact_support") {
    const issueType = String(formData.get("issueType") || "").trim();
    const orderId = String(formData.get("orderId") || "").trim();
    const description = String(formData.get("description") || "").trim();
    const email = String(formData.get("email") || "").trim();
    const attachment = String(formData.get("attachment") || "").trim();
    const shopName = String(formData.get("shopName") || "").trim();

    if (!issueType) {
      return {
        success: false,
        intent: "contact_support",
        error: "Please select an issue type.",
      };
    }

    if (!description) {
      return {
        success: false,
        intent: "contact_support",
        error: "Please provide a description of the issue.",
      };
    }

    const ticket = await createSupportTicket({
      shopDomain: session.shop,
      shopName: shopName || undefined,
      issueType,
      orderId: orderId || null,
      description,
      email: email || `merchant@${session.shop}`,
      attachment: attachment || null,
    });

    return {
      success: true,
      intent: "contact_support",
      ticketNumber: ticket.ticketNumber,
      message: `Support ticket #${ticket.ticketNumber} created! Notification sent to hello@explified.com.`,
    };
  }

  return { success: false, error: "Invalid action intent." };
};

export default function SettingsPage() {
  const { shopName, merchantEmail, settings, initialSupportOpen } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  // Settings form state
  const [sendEditLinkEmail, setSendEditLinkEmail] = useState<boolean>(settings.sendEditLinkEmail);
  const [notifyCustomer, setNotifyCustomer] = useState<boolean>(settings.notifyCustomer);
  const [sendPaymentRefundEmails, setSendPaymentRefundEmails] = useState<boolean>(settings.sendPaymentRefundEmails);
  const [theme, setTheme] = useState<string>(settings.theme || "Light");

  const applyTheme = (selectedTheme: string) => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    const isDark =
      selectedTheme === "Dark" ||
      (selectedTheme === "System" &&
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
  };

  const handleThemeChange = (newTheme: string) => {
    setTheme(newTheme);
    applyTheme(newTheme);
  };

  // Keep state in sync if settings update via revalidation
  useEffect(() => {
    setSendEditLinkEmail(settings.sendEditLinkEmail);
    setNotifyCustomer(settings.notifyCustomer);
    setSendPaymentRefundEmails(settings.sendPaymentRefundEmails);
    setTheme(settings.theme || "Light");
    applyTheme(settings.theme || "Light");
  }, [settings]);

  // Support modal state
  const [isSupportModalOpen, setIsSupportModalOpen] = useState<boolean>(initialSupportOpen || false);
  const [issueType, setIssueType] = useState<string>("");
  const [orderId, setOrderId] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [contactEmail, setContactEmail] = useState<string>(merchantEmail || "");
  const [attachmentName, setAttachmentName] = useState<string>("");
  const [ticketSubmittedNumber, setTicketSubmittedNumber] = useState<string | null>(null);
  const [formValidationError, setFormValidationError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const isSaving = fetcher.state === "submitting" && fetcher.formData?.get("intent") === "save_settings";
  const isSendingSupport = fetcher.state === "submitting" && fetcher.formData?.get("intent") === "contact_support";

  // Handle toast notifications & responses
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.intent === "save_settings") {
      shopify.toast.show(fetcher.data.message || "Settings saved successfully!");
    } else if (fetcher.data?.success && fetcher.data?.intent === "contact_support") {
      shopify.toast.show("Support request sent! Our team will contact you shortly.");
      setTicketSubmittedNumber(fetcher.data.ticketNumber || "TKT-100482");
    } else if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const handleSaveSettings = () => {
    fetcher.submit(
      {
        intent: "save_settings",
        sendEditLinkEmail: String(sendEditLinkEmail),
        notifyCustomer: String(notifyCustomer),
        sendPaymentRefundEmails: String(sendPaymentRefundEmails),
        theme,
      },
      { method: "POST" }
    );
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.size > 5 * 1024 * 1024) {
        alert("File size exceeds 5MB limit.");
        return;
      }
      setAttachmentName(file.name);
    }
  };

  const handleSendSupport = () => {
    setFormValidationError(null);
    if (!issueType) {
      setFormValidationError("Please select an issue type.");
      return;
    }
    if (!description.trim()) {
      setFormValidationError("Please describe the issue in detail.");
      return;
    }

    fetcher.submit(
      {
        intent: "contact_support",
        shopName: shopName || "",
        issueType,
        orderId,
        description,
        email: contactEmail,
        attachment: attachmentName,
      },
      { method: "POST" }
    );
  };

  const handleCloseSupportModal = () => {
    setIsSupportModalOpen(false);
    setTicketSubmittedNumber(null);
    setFormValidationError(null);
  };

  const handleResetSupportForm = () => {
    setIssueType("");
    setOrderId("");
    setDescription("");
    setAttachmentName("");
    setTicketSubmittedNumber(null);
    setFormValidationError(null);
  };

  return (
    <div className="cm-settings-container">
      {/* Header */}
      <div className="cm-settings-header">
        <h1 className="cm-settings-title">Settings</h1>
        <p className="cm-settings-subtitle">
          Manage your CartMend app preferences and integration.
        </p>
      </div>

      {/* Main Settings Card */}
      <div className="cm-settings-card">
        {/* Section 1: Email notifications */}
        <div className="cm-settings-section">
          <div className="cm-settings-section-left">
            <div className="cm-settings-icon-badge">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#008060" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="20" height="16" x="2" y="4" rx="2" />
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
              </svg>
            </div>
            <h2 className="cm-settings-section-title">Email notifications</h2>
            <p className="cm-settings-section-desc">
              Control email communication sent by CartMend.
            </p>
          </div>

          <div className="cm-settings-items-list">
            {/* Row 1 */}
            <div
              className="cm-settings-item-row"
              style={{ cursor: "pointer", userSelect: "none" }}
              onClick={() => setSendEditLinkEmail((prev) => !prev)}
            >
              <div className="cm-settings-item-info">
                <div className="cm-settings-item-title">Send edit request &amp; status updates</div>
                <div className="cm-settings-item-desc">
                  Email customers when edits are requested or updated.
                </div>
              </div>
              <label
                className="cm-toggle-wrapper"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  id="toggle-send-edit-link"
                  checked={sendEditLinkEmail}
                  onChange={(e) => setSendEditLinkEmail(e.target.checked)}
                />
                <span className="cm-toggle-slider" />
              </label>
            </div>

            {/* Row 2 */}
            <div
              className="cm-settings-item-row"
              style={{ cursor: "pointer", userSelect: "none" }}
              onClick={() => setNotifyCustomer((prev) => !prev)}
            >
              <div className="cm-settings-item-info">
                <div className="cm-settings-item-title">Send order updated confirmation</div>
                <div className="cm-settings-item-desc">
                  Email customers when their order is successfully updated.
                </div>
              </div>
              <label
                className="cm-toggle-wrapper"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  id="toggle-notify-customer"
                  checked={notifyCustomer}
                  onChange={(e) => setNotifyCustomer(e.target.checked)}
                />
                <span className="cm-toggle-slider" />
              </label>
            </div>

            {/* Row 3 */}
            <div
              className="cm-settings-item-row"
              style={{ cursor: "pointer", userSelect: "none" }}
              onClick={() => setSendPaymentRefundEmails((prev) => !prev)}
            >
              <div className="cm-settings-item-info">
                <div className="cm-settings-item-title">Send payment or refund emails</div>
                <div className="cm-settings-item-desc">
                  Email customers for payments received or refunds issued.
                </div>
              </div>
              <label
                className="cm-toggle-wrapper"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  id="toggle-send-payment-refund"
                  checked={sendPaymentRefundEmails}
                  onChange={(e) => setSendPaymentRefundEmails(e.target.checked)}
                />
                <span className="cm-toggle-slider" />
              </label>
            </div>
          </div>
        </div>

        {/* Section 2: Appearance */}
        <div className="cm-settings-section">
          <div className="cm-settings-section-left">
            <div className="cm-settings-icon-badge">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#008060" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="13.5" cy="6.5" r=".5" fill="#008060" />
                <circle cx="17.5" cy="10.5" r=".5" fill="#008060" />
                <circle cx="8.5" cy="7.5" r=".5" fill="#008060" />
                <circle cx="6.5" cy="12.5" r=".5" fill="#008060" />
                <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
              </svg>
            </div>
            <h2 className="cm-settings-section-title">Appearance</h2>
            <p className="cm-settings-section-desc">
              Manage how CartMend looks inside your Shopify admin.
            </p>
          </div>

          <div className="cm-settings-items-list">
            <div className="cm-settings-item-row">
              <div className="cm-settings-item-info">
                <div className="cm-settings-item-title">Theme</div>
                <div className="cm-settings-item-desc">
                  Choose the theme for CartMend inside Shopify admin.
                </div>
              </div>
              <div>
                <select
                  id="select-theme"
                  value={theme}
                  onChange={(e) => handleThemeChange(e.target.value)}
                  className="cm-select-field"
                >
                  <option value="Light">Light</option>
                  <option value="Dark">Dark</option>
                  <option value="System">System</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* Section 3: Support & about */}
        <div className="cm-settings-section">
          <div className="cm-settings-section-left">
            <div className="cm-settings-icon-badge">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#008060" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
              </svg>
            </div>
            <h2 className="cm-settings-section-title">Support &amp; about</h2>
            <p className="cm-settings-section-desc">
              Get help and learn more about CartMend.
            </p>
          </div>

          <div className="cm-settings-items-list">
            {/* Contact support */}
            <div className="cm-settings-item-row">
              <div className="cm-settings-item-info">
                <div className="cm-settings-item-title">Contact support</div>
                <div className="cm-settings-item-desc">
                  Get help from our support team.
                </div>
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => {
                    handleResetSupportForm();
                    setIsSupportModalOpen(true);
                  }}
                  className="cm-action-btn-outline"
                >
                  Contact support
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </button>
              </div>
            </div>

            {/* About CartMend */}
            <div className="cm-settings-item-row">
              <div className="cm-settings-item-info">
                <div className="cm-settings-item-title">About CartMend</div>
                <div className="cm-settings-item-desc">
                  Learn more about CartMend and our policies.
                </div>
              </div>
              <div>
                <a
                  href="https://cartmend.com/docs"
                  target="_blank"
                  rel="noreferrer"
                  className="cm-action-btn-outline"
                >
                  View docs
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer Save Button */}
      <div className="cm-settings-footer">
        <button
          type="button"
          onClick={handleSaveSettings}
          disabled={isSaving}
          className="cm-save-changes-btn"
        >
          {isSaving ? "Saving..." : "Save changes"}
        </button>
      </div>

      {/* ===================================================================
          CONTACT CARTMEND SUPPORT MODAL (MATCHING SCREENSHOT 2)
          =================================================================== */}
      {isSupportModalOpen && (
        <div
          className="cm-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCloseSupportModal();
          }}
        >
          <div className="cm-modal-card" role="dialog" aria-modal="true">
            {/* Modal Header */}
            <div className="cm-modal-header">
              <div>
                <h3 className="cm-modal-title">Contact CartMend Support</h3>
                <p className="cm-modal-sub">
                  We&apos;re here to help! Tell us what&apos;s going on and our team will get back to you.
                </p>
              </div>
              <button
                type="button"
                onClick={handleCloseSupportModal}
                className="cm-modal-close-btn"
                title="Close"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {ticketSubmittedNumber ? (
              /* Success Confirmation Screen */
              <div className="cm-modal-body" style={{ textAlign: "center", padding: "40px 28px" }}>
                <div
                  style={{
                    width: "56px",
                    height: "56px",
                    borderRadius: "50%",
                    backgroundColor: "#dcfce7",
                    color: "#15803d",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "28px",
                    fontWeight: "bold",
                    marginBottom: "16px",
                  }}
                >
                  ✓
                </div>
                <h4 style={{ fontSize: "18px", fontWeight: 700, margin: "0 0 8px 0", color: "#0f172a" }}>
                  Support Request Received!
                </h4>
                <p style={{ fontSize: "13.5px", color: "#64748b", margin: "0 0 16px 0", lineHeight: 1.5 }}>
                  Your ticket reference is <strong>#{ticketSubmittedNumber}</strong>. A notification has been sent to our dedicated team at <strong>hello@explified.com</strong>, and we will follow up with you at <strong>{contactEmail}</strong> shortly.
                </p>
                <button
                  type="button"
                  onClick={handleCloseSupportModal}
                  className="cm-modal-submit-btn"
                  style={{ width: "auto", minWidth: "140px", justifyContent: "center" }}
                >
                  Done
                </button>
              </div>
            ) : (
              /* Support Form */
              <>
                <div className="cm-modal-body">
                  {formValidationError && (
                    <div
                      style={{
                        background: "#fef2f2",
                        border: "1px solid #fecaca",
                        color: "#dc2626",
                        padding: "10px 14px",
                        borderRadius: "8px",
                        fontSize: "13px",
                        marginBottom: "16px",
                      }}
                    >
                      ⚠️ {formValidationError}
                    </div>
                  )}

                  {/* Field 1: Issue Type */}
                  <div className="cm-modal-field">
                    <label className="cm-modal-label">
                      What can we help you with?<span className="cm-modal-req">*</span>
                    </label>
                    <select
                      value={issueType}
                      onChange={(e) => setIssueType(e.target.value)}
                      className="cm-modal-select"
                      style={{ color: issueType ? "#0f172a" : "#94a3b8" }}
                    >
                      <option value="" disabled>Select an issue type</option>
                      <option value="Order Editing Issue">Order Editing Issue</option>
                      <option value="Storefront Integration">Storefront &amp; Theme Integration</option>
                      <option value="Billing & Payments">Billing, Payments &amp; Invoicing</option>
                      <option value="Feature Request">Feature Request</option>
                      <option value="Bug Report">Bug Report / Technical Issue</option>
                      <option value="General Question">General Question</option>
                    </select>
                  </div>

                  {/* Field 2: Order ID (Optional) */}
                  <div className="cm-modal-field">
                    <label className="cm-modal-label">
                      Order ID<span className="cm-modal-opt">(optional)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. #10482"
                      value={orderId}
                      onChange={(e) => setOrderId(e.target.value)}
                      className="cm-modal-input"
                    />
                    <p className="cm-modal-helper">
                      Adding an order ID helps us resolve your issue faster.
                    </p>
                  </div>

                  {/* Field 3: Describe the issue */}
                  <div className="cm-modal-field">
                    <label className="cm-modal-label">
                      Describe the issue<span className="cm-modal-req">*</span>
                    </label>
                    <textarea
                      rows={4}
                      placeholder="Please provide as much detail as possible..."
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="cm-modal-textarea"
                    />
                    <p className="cm-modal-helper">
                      The more details you share, the faster we can help.
                    </p>
                  </div>

                  {/* Field 4: Attachments (Optional) */}
                  <div className="cm-modal-field">
                    <label className="cm-modal-label">
                      Attachments<span className="cm-modal-opt">(optional)</span>
                    </label>
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileSelect}
                      accept="image/png, image/jpeg, image/webp"
                      style={{ display: "none" }}
                    />
                    <div
                      className="cm-modal-upload-box"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <div className="cm-modal-upload-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="17 8 12 3 7 8" />
                          <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div className="cm-modal-upload-title">
                          {attachmentName ? `Attached: ${attachmentName}` : "Add screenshot"}
                        </div>
                        <div className="cm-modal-upload-sub">PNG, JPG up to 5MB</div>
                      </div>
                      {attachmentName && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setAttachmentName("");
                            if (fileInputRef.current) fileInputRef.current.value = "";
                          }}
                          style={{
                            background: "transparent",
                            border: "none",
                            color: "#94a3b8",
                            cursor: "pointer",
                            padding: "4px",
                          }}
                          title="Remove file"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Field 5: Your email */}
                  <div className="cm-modal-field" style={{ marginBottom: 0 }}>
                    <label className="cm-modal-label">Your email</label>
                    <input
                      type="email"
                      placeholder="merchant@email.com"
                      value={contactEmail}
                      onChange={(e) => setContactEmail(e.target.value)}
                      className="cm-modal-input"
                    />
                    <p className="cm-modal-helper">
                      We&apos;ll use this email to get back to you.
                    </p>
                  </div>
                </div>

                {/* Modal Footer */}
                <div className="cm-modal-footer">
                  <div className="cm-modal-actions">
                    <button
                      type="button"
                      onClick={handleCloseSupportModal}
                      className="cm-modal-cancel-btn"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSendSupport}
                      disabled={isSendingSupport}
                      className="cm-modal-submit-btn"
                    >
                      {isSendingSupport ? "Sending..." : "Send request"}
                    </button>
                  </div>

                  <div className="cm-modal-security-note">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    <span>Your information is safe with us and will only be used to assist you.</span>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

