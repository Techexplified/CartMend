import { useState, useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { updateMerchantSettings, getMerchantSettings } from "../services/merchant-settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let settings = await prisma.appSettings.findUnique({
    where: { shop },
  });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: {
        shop,
        isActivated: false,
        editWindowHours: 24,
        allowAddressEdit: true,
        allowQuantityChange: true,
        allowItemSwap: true,
        allowOrderCancellation: true,
        requireCustomerAccount: false,
        notifyMerchantOnEdit: true,
      },
    });
  }

  const merchantSettings = await getMerchantSettings(shop);

  let extraConfig = {
    editWindowUnit: "Hours",
    cutoffTime: "11:59 PM",
    timezone: "(GMT+05:30) Asia/Kolkata",
    fulfillmentRestriction: "ONLY_BEFORE_FULFILLMENT",
    cancellationCondition: "ONLY_BEFORE_FULFILLMENT",
    refundMethod: "ORIGINAL_PAYMENT_METHOD",
    restockingFee: 0,
    additionalPaymentBehavior: "CAPTURE_AUTOMATICALLY",
    refundBehavior: "ISSUE_AUTOMATICALLY",
    allowPartialRefunds: true,
  };

  if (settings.supportEmail && settings.supportEmail.startsWith("{")) {
    try {
      const parsed = JSON.parse(settings.supportEmail);
      extraConfig = { ...extraConfig, ...parsed };
    } catch (e) {
      // fallback to defaults
    }
  }

  const totalMins = merchantSettings.editingWindowMinutes ?? 180;
  let initialWindowValue = 3;
  let initialWindowUnit = "Hours";

  if (extraConfig?.editWindowUnit === "Minutes" || totalMins < 60) {
    initialWindowValue = totalMins;
    initialWindowUnit = "Minutes";
  } else if (extraConfig?.editWindowUnit === "Days" || (totalMins % 1440 === 0 && totalMins >= 1440)) {
    initialWindowValue = Math.round(totalMins / 1440);
    initialWindowUnit = "Days";
  } else {
    initialWindowValue = Math.round(totalMins / 60);
    initialWindowUnit = "Hours";
  }

  return {
    settings,
    extraConfig,
    isEditingEnabled: merchantSettings.editingEnabled,
    initialWindowValue,
    initialWindowUnit,
    editingWindowMinutes: totalMins,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "toggle_activation") {
    const currentStatus = formData.get("currentStatus") === "true";
    const nextStatus = !currentStatus;

    await updateMerchantSettings(session.shop, { editingEnabled: nextStatus });

    return {
      success: true,
      isEditingEnabled: nextStatus,
      message: nextStatus
        ? "Order editing is now ENABLED!"
        : "Order editing has been DISABLED.",
    };
  }

  const editWindowValue = Number(formData.get("editWindowHours") || 24);
  const editWindowUnit = String(formData.get("editWindowUnit") || "Hours");
  const allowAddressEdit = formData.get("allowAddressEdit") === "on";
  const allowItemSwap = formData.get("allowItemSwap") === "on";
  const allowQuantityChange = formData.get("allowQuantityChange") === "on";
  const allowOrderCancellation = formData.get("allowOrderCancellation") === "on";
  const isEditingEnabled = formData.get("isEditingEnabled") === "true";

  let editingWindowMinutes = editWindowValue * 60;
  if (editWindowUnit === "Minutes") {
    editingWindowMinutes = editWindowValue;
  } else if (editWindowUnit === "Days") {
    editingWindowMinutes = editWindowValue * 24 * 60;
  } else {
    editingWindowMinutes = editWindowValue * 60;
  }
  editingWindowMinutes = Math.max(1, Math.floor(editingWindowMinutes));

  const extraConfig = {
    editWindowUnit,
    cutoffTime: String(formData.get("cutoffTime") || "11:59 PM"),
    timezone: String(formData.get("timezone") || "(GMT+05:30) Asia/Kolkata"),
    fulfillmentRestriction: String(formData.get("fulfillmentRestriction") || "ONLY_BEFORE_FULFILLMENT"),
    cancellationCondition: String(formData.get("cancellationCondition") || "ONLY_BEFORE_FULFILLMENT"),
    refundMethod: String(formData.get("refundMethod") || "ORIGINAL_PAYMENT_METHOD"),
    restockingFee: Number(formData.get("restockingFee") || 0),
    additionalPaymentBehavior: String(formData.get("additionalPaymentBehavior") || "CAPTURE_AUTOMATICALLY"),
    refundBehavior: String(formData.get("refundBehavior") || "ISSUE_AUTOMATICALLY"),
    allowPartialRefunds: formData.get("allowPartialRefunds") === "on",
    rulesConfigured: true,
  };

  await prisma.appSettings.upsert({
    where: { shop: session.shop },
    update: {
      editWindowHours: Math.max(1, Math.round(editingWindowMinutes / 60)),
      allowAddressEdit,
      allowQuantityChange,
      allowItemSwap,
      allowOrderCancellation,
      supportEmail: JSON.stringify(extraConfig),
    },
    create: {
      shop: session.shop,
      isActivated: isEditingEnabled,
      editWindowHours: Math.max(1, Math.round(editingWindowMinutes / 60)),
      allowAddressEdit,
      allowQuantityChange,
      allowItemSwap,
      allowOrderCancellation,
      supportEmail: JSON.stringify(extraConfig),
    },
  });

  // Synchronize with CartMend backend ShopSettings
  await updateMerchantSettings(session.shop, {
    editingEnabled: isEditingEnabled,
    editingWindowMinutes,
    allowAddressChange: allowAddressEdit,
    allowQuantityChange: allowQuantityChange,
    allowVariantChange: allowItemSwap,
    allowRemoveProduct: allowOrderCancellation,
  });

  return { success: true, isEditingEnabled, message: "Editing rules saved successfully!" };
};

export default function EditingRules() {
  const loaderData = useLoaderData<typeof loader>();
  const { settings, extraConfig } = loaderData;
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const isEditingEnabled =
    fetcher.data?.isEditingEnabled !== undefined
      ? fetcher.data.isEditingEnabled
      : (loaderData.isEditingEnabled ?? settings.isActivated);

  // State management for instant interactive control
  const [allowAddressEdit, setAllowAddressEdit] = useState(settings.allowAddressEdit ?? true);
  const [allowItemSwap, setAllowItemSwap] = useState(settings.allowItemSwap ?? true);
  const [allowQuantityChange, setAllowQuantityChange] = useState(settings.allowQuantityChange ?? true);
  const [allowOrderCancellation, setAllowOrderCancellation] = useState(settings.allowOrderCancellation ?? true);

  const [editWindowHours, setEditWindowHours] = useState(loaderData.initialWindowValue ?? settings.editWindowHours ?? 24);
  const [editWindowUnit, setEditWindowUnit] = useState(loaderData.initialWindowUnit ?? extraConfig?.editWindowUnit ?? "Hours");
  const [cutoffTime, setCutoffTime] = useState(extraConfig?.cutoffTime ?? "11:59 PM");
  const [timezone, setTimezone] = useState(extraConfig?.timezone ?? "(GMT+05:30) Asia/Kolkata");

  const [fulfillmentRestriction, setFulfillmentRestriction] = useState(extraConfig?.fulfillmentRestriction ?? "ONLY_BEFORE_FULFILLMENT");
  const [cancellationCondition, setCancellationCondition] = useState(extraConfig?.cancellationCondition ?? "ONLY_BEFORE_FULFILLMENT");
  const [refundMethod, setRefundMethod] = useState(extraConfig?.refundMethod ?? "ORIGINAL_PAYMENT_METHOD");
  const [restockingFee, setRestockingFee] = useState(extraConfig?.restockingFee ?? 0);

  const [additionalPaymentBehavior, setAdditionalPaymentBehavior] = useState(extraConfig?.additionalPaymentBehavior ?? "CAPTURE_AUTOMATICALLY");
  const [refundBehavior, setRefundBehavior] = useState(extraConfig?.refundBehavior ?? "ISSUE_AUTOMATICALLY");
  const [allowPartialRefunds, setAllowPartialRefunds] = useState(extraConfig?.allowPartialRefunds ?? true);

  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);

  // Storefront Simulator State
  const [sfStep, setSfStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [sfTab, setSfTab] = useState<"address" | "items" | "quantity" | "cancel" | "payment">("address");
  const [sfAddress, setSfAddress] = useState({
    fullName: "Vivek Chahar",
    phone: "+91 98765 43210",
    address: "B-12, Sector 62",
    apartment: "Tower 4, Block C",
    city: "Noida",
    province: "Uttar Pradesh",
    zip: "201309",
    isDefault: false,
  });
  const [sneakersQty, setSneakersQty] = useState(2);
  const [cancelReason, setCancelReason] = useState("Order created by mistake");

  // Dynamically calculate preview countdown timer based on merchant's selected edit window
  const computeWindowSeconds = (val: number | string, unit: string) => {
    const num = Number(val) || 24;
    if (unit === "Minutes") return num * 60;
    if (unit === "Days") return num * 24 * 3600;
    return num * 3600;
  };

  const [secondsRemaining, setSecondsRemaining] = useState(() =>
    computeWindowSeconds(loaderData.initialWindowValue ?? settings.editWindowHours ?? 24, loaderData.initialWindowUnit ?? extraConfig?.editWindowUnit ?? "Hours")
  );

  // Keep countdown in exact sync with merchant's configured hours/unit
  useEffect(() => {
    setSecondsRemaining(computeWindowSeconds(editWindowHours, editWindowUnit));
  }, [editWindowHours, editWindowUnit, isPreviewOpen]);

  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsRemaining((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTimer = (totalSecs: number) => {
    if (totalSecs <= 0) return "00m : 00s";
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    if (hrs > 0) {
      return `${hrs}h : ${mins.toString().padStart(2, "0")}m : ${secs.toString().padStart(2, "0")}s`;
    }
    return `${mins.toString().padStart(2, "0")}m : ${secs.toString().padStart(2, "0")}s`;
  };

  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message);
    }
  }, [fetcher.data, shopify]);

  const handleReset = () => {
    setAllowAddressEdit(settings.allowAddressEdit ?? true);
    setAllowItemSwap(settings.allowItemSwap ?? true);
    setAllowQuantityChange(settings.allowQuantityChange ?? true);
    setAllowOrderCancellation(settings.allowOrderCancellation ?? true);
    setEditWindowHours(settings.editWindowHours ?? 24);
    setEditWindowUnit(extraConfig?.editWindowUnit ?? "Hours");
    setCutoffTime(extraConfig?.cutoffTime ?? "11:59 PM");
    setTimezone(extraConfig?.timezone ?? "(GMT+05:30) Asia/Kolkata");
    setFulfillmentRestriction(extraConfig?.fulfillmentRestriction ?? "ONLY_BEFORE_FULFILLMENT");
    setCancellationCondition(extraConfig?.cancellationCondition ?? "ONLY_BEFORE_FULFILLMENT");
    setRefundMethod(extraConfig?.refundMethod ?? "ORIGINAL_PAYMENT_METHOD");
    setRestockingFee(extraConfig?.restockingFee ?? 0);
    setAdditionalPaymentBehavior(extraConfig?.additionalPaymentBehavior ?? "CAPTURE_AUTOMATICALLY");
    setRefundBehavior(extraConfig?.refundBehavior ?? "ISSUE_AUTOMATICALLY");
    setAllowPartialRefunds(extraConfig?.allowPartialRefunds ?? true);
    shopify.toast.show("Changes discarded.");
  };

  const isSaving = fetcher.state === "submitting";

  return (
    <div className="cartmend-container">
      {/* Top Header */}
      <div className="cm-rules-header">
        <div>
          <h1 className="cm-title">Editing Rules &amp; Safety Settings</h1>
          <p className="cm-subtitle">
            Control what your customers can edit, when they can do it, and what happens based on order status.
          </p>
        </div>

        <div className="cm-rules-header-actions" style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {/* Primary Enable/Disable Toggle Button */}
          <button
            type="button"
            onClick={() => {
              fetcher.submit(
                { intent: "toggle_activation", currentStatus: String(isEditingEnabled) },
                { method: "POST" }
              );
            }}
            className={isEditingEnabled ? "cm-btn-outline" : "cm-btn-primary"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              padding: "8px 18px",
              borderRadius: "8px",
              fontWeight: 600,
              fontSize: "13.5px",
              cursor: "pointer",
              backgroundColor: isEditingEnabled ? "#fff" : "#008060",
              borderColor: isEditingEnabled ? "#d82c0d" : "#008060",
              color: isEditingEnabled ? "#d82c0d" : "#ffffff",
              boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
              transition: "all 0.15s ease",
            }}
          >
            <span
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                backgroundColor: isEditingEnabled ? "#d82c0d" : "#a7f3d0",
              }}
            />
            {isEditingEnabled ? "Disable Order Editing" : "Enable Order Editing"}
          </button>

          <span
            className={isEditingEnabled ? "cm-badge-active" : "cm-badge-completed"}
            style={{
              padding: "6px 12px",
              borderRadius: "16px",
              fontSize: "13px",
              fontWeight: 600,
              backgroundColor: isEditingEnabled ? "#dcfce7" : "#f3f4f6",
              color: isEditingEnabled ? "#15803d" : "#6b7280",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <span
              className="cm-status-dot"
              style={{ backgroundColor: isEditingEnabled ? "#22c55e" : "#9ca3af" }}
            />
            {isEditingEnabled ? "Status: Active" : "Status: Disabled"}
          </span>

          <button
            type="button"
            className="cm-btn-outline"
            onClick={() => setIsPreviewOpen(true)}
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            {/* Eye preview icon */}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: "16px", height: "16px" }}>
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            Preview customer experience
          </button>
        </div>
      </div>

      <fetcher.Form method="post">
        <input type="hidden" name="isEditingEnabled" value={String(isEditingEnabled)} />
        {/* Top 3-Column Grid */}
        <div className="cm-rules-top-grid">
          {/* Card 1: 1. Allowed edits */}
          <div className="cm-card">
            <h2 className="cm-card-title">1. Allowed edits</h2>
            <p className="cm-card-desc">Choose what your customers can edit.</p>

            <div className="cm-toggle-list">
              {/* Shipping address */}
              <div className="cm-toggle-row">
                <div className="cm-toggle-info">
                  <div className="cm-toggle-icon">
                    {/* Location Pin Icon */}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
                      <circle cx="12" cy="10" r="3" />
                    </svg>
                  </div>
                  <div>
                    <div className="cm-toggle-title">Shipping address</div>
                    <div className="cm-toggle-sub">Allow customers to change their shipping address.</div>
                  </div>
                </div>
                <label className="cm-switch">
                  <input
                    type="checkbox"
                    name="allowAddressEdit"
                    checked={allowAddressEdit}
                    onChange={(e) => setAllowAddressEdit(e.target.checked)}
                  />
                  <span className="cm-slider" />
                </label>
              </div>

              {/* Items & variants */}
              <div className="cm-toggle-row">
                <div className="cm-toggle-info">
                  <div className="cm-toggle-icon">
                    {/* Package Icon */}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m7.5 4.27 9 5.15" />
                      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                      <path d="m3.3 7 8.7 5 8.7-5" />
                      <path d="M12 22V12" />
                    </svg>
                  </div>
                  <div>
                    <div className="cm-toggle-title">Items &amp; variants</div>
                    <div className="cm-toggle-sub">Allow change of products or variants.</div>
                  </div>
                </div>
                <label className="cm-switch">
                  <input
                    type="checkbox"
                    name="allowItemSwap"
                    checked={allowItemSwap}
                    onChange={(e) => setAllowItemSwap(e.target.checked)}
                  />
                  <span className="cm-slider" />
                </label>
              </div>

              {/* Quantity */}
              <div className="cm-toggle-row">
                <div className="cm-toggle-info">
                  <div className="cm-toggle-icon">
                    {/* Hash icon */}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="4" y1="9" x2="20" y2="9" />
                      <line x1="4" y1="15" x2="20" y2="15" />
                      <line x1="10" y1="3" x2="8" y2="21" />
                      <line x1="16" y1="3" x2="14" y2="21" />
                    </svg>
                  </div>
                  <div>
                    <div className="cm-toggle-title">Quantity</div>
                    <div className="cm-toggle-sub">Allow customers to update item quantities.</div>
                  </div>
                </div>
                <label className="cm-switch">
                  <input
                    type="checkbox"
                    name="allowQuantityChange"
                    checked={allowQuantityChange}
                    onChange={(e) => setAllowQuantityChange(e.target.checked)}
                  />
                  <span className="cm-slider" />
                </label>
              </div>

              {/* Cancel order */}
              <div className="cm-toggle-row">
                <div className="cm-toggle-info">
                  <div className="cm-toggle-icon">
                    {/* Cancel / X in circle icon */}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="15" y1="9" x2="9" y2="15" />
                      <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                  </div>
                  <div>
                    <div className="cm-toggle-title">Cancel order</div>
                    <div className="cm-toggle-sub">Allow customers to cancel their entire order.</div>
                  </div>
                </div>
                <label className="cm-switch">
                  <input
                    type="checkbox"
                    name="allowOrderCancellation"
                    checked={allowOrderCancellation}
                    onChange={(e) => setAllowOrderCancellation(e.target.checked)}
                  />
                  <span className="cm-slider" />
                </label>
              </div>
            </div>

            {/* Blue Info Box */}
            <div className="cm-info-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <span>Changes are always subject to availability, validation and your rules.</span>
            </div>
          </div>

          {/* Card 2: 2. Edit window */}
          <div className="cm-card">
            <h2 className="cm-card-title">2. Edit window</h2>
            <p className="cm-card-desc">Set the time window during which edits are allowed.</p>

            <div className="cm-form-group">
              <label className="cm-label">Allow edits for</label>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <input
                  type="number"
                  name="editWindowHours"
                  min="1"
                  max="720"
                  value={editWindowHours}
                  onChange={(e) => setEditWindowHours(Number(e.target.value))}
                  className="cm-input"
                  style={{ width: "90px", fontWeight: 600 }}
                />
                <select
                  name="editWindowUnit"
                  value={editWindowUnit}
                  onChange={(e) => setEditWindowUnit(e.target.value)}
                  className="cm-select"
                  style={{ flex: 1 }}
                >
                  <option value="Hours">Hours</option>
                  <option value="Minutes">Minutes</option>
                  <option value="Days">Days</option>
                </select>
              </div>
              <div style={{ fontSize: "11.5px", color: "#6d7175", marginTop: "4px" }}>
                after the order is placed
              </div>
            </div>

            <div className="cm-form-group">
              <label className="cm-label">Cut-off time</label>
              <div style={{ fontSize: "11.5px", color: "#6d7175", marginBottom: "4px" }}>
                Edits won&apos;t be allowed after this time.
              </div>
              <div className="cm-input-icon-wrap" style={{ marginBottom: "8px" }}>
                <input
                  type="text"
                  name="cutoffTime"
                  value={cutoffTime}
                  onChange={(e) => setCutoffTime(e.target.value)}
                  className="cm-input"
                />
                <span className="cm-input-icon">
                  {/* Clock icon */}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </span>
              </div>

              <select
                name="timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="cm-select"
              >
                <option value="(GMT+05:30) Asia/Kolkata">(GMT+05:30) Asia/Kolkata</option>
                <option value="(GMT+00:00) UTC">(GMT+00:00) UTC</option>
                <option value="(GMT-05:00) America/New_York">(GMT-05:00) America/New_York</option>
                <option value="(GMT-08:00) America/Los_Angeles">(GMT-08:00) America/Los_Angeles</option>
                <option value="(GMT+08:00) Asia/Singapore">(GMT+08:00) Asia/Singapore</option>
              </select>
            </div>

            {/* Bottom Row inside card */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #f1f2f3", paddingTop: "10px", marginTop: "auto" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#1a1a1a" }}>
                {/* Calendar Icon */}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "15px", height: "15px", color: "#6d7175" }}>
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
                <span>Applies to all days of the week</span>
              </div>
              <button
                type="button"
                className="cm-btn-outline"
                style={{ padding: "4px 10px", fontSize: "12px" }}
                onClick={() => setIsScheduleModalOpen(true)}
              >
                Edit
              </button>
            </div>
          </div>

          {/* Card 3: 3. Fulfillment restrictions */}
          <div className="cm-card">
            <h2 className="cm-card-title">3. Fulfillment restrictions</h2>
            <p className="cm-card-desc">Define when edits are allowed based on fulfillment.</p>

            <div className="cm-radio-list">
              <label className="cm-radio-item" onClick={() => setFulfillmentRestriction("ONLY_BEFORE_FULFILLMENT")}>
                <input
                  type="radio"
                  name="fulfillmentRestriction"
                  value="ONLY_BEFORE_FULFILLMENT"
                  checked={fulfillmentRestriction === "ONLY_BEFORE_FULFILLMENT"}
                  onChange={() => setFulfillmentRestriction("ONLY_BEFORE_FULFILLMENT")}
                />
                <span className="cm-radio-custom" />
                <div>
                  <div className="cm-radio-title">Only before fulfillment</div>
                  <div className="cm-radio-desc">No edits once any item in the order is fulfilled.</div>
                </div>
              </label>

              <label className="cm-radio-item" onClick={() => setFulfillmentRestriction("UNTIL_FULLY_FULFILLED")}>
                <input
                  type="radio"
                  name="fulfillmentRestriction"
                  value="UNTIL_FULLY_FULFILLED"
                  checked={fulfillmentRestriction === "UNTIL_FULLY_FULFILLED"}
                  onChange={() => setFulfillmentRestriction("UNTIL_FULLY_FULFILLED")}
                />
                <span className="cm-radio-custom" />
                <div>
                  <div className="cm-radio-title">Allow edits until order is fully fulfilled</div>
                  <div className="cm-radio-desc">Customers can edit unfulfilled items only.</div>
                </div>
              </label>

              <label className="cm-radio-item" onClick={() => setFulfillmentRestriction("EVEN_AFTER_FULFILLMENT")}>
                <input
                  type="radio"
                  name="fulfillmentRestriction"
                  value="EVEN_AFTER_FULFILLMENT"
                  checked={fulfillmentRestriction === "EVEN_AFTER_FULFILLMENT"}
                  onChange={() => setFulfillmentRestriction("EVEN_AFTER_FULFILLMENT")}
                />
                <span className="cm-radio-custom" />
                <div>
                  <div className="cm-radio-title">Allow edits even after fulfillment</div>
                  <div className="cm-radio-desc">For returns or changes after fulfillment.</div>
                </div>
              </label>
            </div>

            {/* Warning Box */}
            <div className="cm-warning-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>Enabling edits after fulfillment may impact shipping and inventory.</span>
            </div>
          </div>
        </div>

        {/* Bottom 2-Column Grid */}
        <div className="cm-rules-bottom-grid">
          {/* Card 4: 4. Cancellation rules */}
          <div className="cm-card">
            <h2 className="cm-card-title">4. Cancellation rules</h2>
            <p className="cm-card-desc">Set conditions for order cancellation and refunds.</p>

            <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: "16px" }}>
              {/* Left Column in Card 4 */}
              <div>
                <div className="cm-form-group">
                  <label className="cm-label">Allow cancellations</label>
                  <select
                    name="cancellationCondition"
                    value={cancellationCondition}
                    onChange={(e) => setCancellationCondition(e.target.value)}
                    className="cm-select"
                  >
                    <option value="ONLY_BEFORE_FULFILLMENT">Only before fulfillment</option>
                    <option value="WITHIN_EDIT_WINDOW">Within the edit window</option>
                    <option value="ALWAYS_ALLOW">Always allow</option>
                    <option value="NEVER">Never</option>
                  </select>
                </div>

                <div className="cm-form-group">
                  <label className="cm-label">Refund method</label>
                  <select
                    name="refundMethod"
                    value={refundMethod}
                    onChange={(e) => setRefundMethod(e.target.value)}
                    className="cm-select"
                  >
                    <option value="ORIGINAL_PAYMENT_METHOD">Refund to original payment method</option>
                    <option value="STORE_CREDIT">Issue store credit / Gift card</option>
                    <option value="MANUAL_REVIEW">Manual review by merchant</option>
                  </select>
                </div>

                <div className="cm-form-group" style={{ marginBottom: 0 }}>
                  <label className="cm-label">Restocking fee</label>
                  <div className="cm-input-suffix-wrap">
                    <input
                      type="number"
                      name="restockingFee"
                      min="0"
                      max="100"
                      value={restockingFee}
                      onChange={(e) => setRestockingFee(Number(e.target.value))}
                      className="cm-input"
                    />
                    <span className="cm-input-suffix">%</span>
                  </div>
                  <div style={{ fontSize: "11px", color: "#6d7175", marginTop: "3px" }}>
                    Applicable when cancellation is allowed.
                  </div>
                </div>
              </div>

              {/* Right Column in Card 4 (Nested Criteria Card) */}
              <div className="cm-nested-card">
                <div className="cm-nested-title">When cancellation is allowed</div>
                <div className="cm-criteria-list">
                  <div className="cm-criteria-item">
                    <span className="cm-criteria-check">✓</span>
                    <span>Before fulfillment</span>
                  </div>
                  <div className="cm-criteria-item">
                    <span className="cm-criteria-check">✓</span>
                    <span>Within the edit window</span>
                  </div>
                  <div className="cm-criteria-item">
                    <span className="cm-criteria-check">✓</span>
                    <span>All items in the order are unfulfilled</span>
                  </div>
                </div>

                <div className="cm-info-box" style={{ fontSize: "11px", padding: "6px 8px" }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "14px", height: "14px" }}>
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                  <span>Cancellation availability will be shown to customers based on these rules.</span>
                </div>
              </div>
            </div>
          </div>

          {/* Card 5: 5. Payment & refund behavior */}
          <div className="cm-card">
            <h2 className="cm-card-title">5. Payment &amp; refund behavior</h2>
            <p className="cm-card-desc">Choose how additional payments and refunds are handled.</p>

            <div className="cm-form-group">
              <label className="cm-label">Additional payments</label>
              <select
                name="additionalPaymentBehavior"
                value={additionalPaymentBehavior}
                onChange={(e) => setAdditionalPaymentBehavior(e.target.value)}
                className="cm-select"
              >
                <option value="CAPTURE_AUTOMATICALLY">Capture automatically</option>
                <option value="REQUIRE_AUTH">Require customer re-authorization</option>
                <option value="SEND_INVOICE">Send invoice to customer</option>
              </select>
            </div>

            <div className="cm-form-group">
              <label className="cm-label">Refunds</label>
              <select
                name="refundBehavior"
                value={refundBehavior}
                onChange={(e) => setRefundBehavior(e.target.value)}
                className="cm-select"
              >
                <option value="ISSUE_AUTOMATICALLY">Issue automatically</option>
                <option value="DRAFT_REVIEW">Draft refund for merchant review</option>
              </select>
            </div>

            {/* Partial refunds toggle */}
            <div className="cm-toggle-row" style={{ marginTop: "12px", paddingTop: "8px", borderTop: "1px solid #f1f2f3" }}>
              <div>
                <div className="cm-toggle-title">Partial refunds</div>
                <div className="cm-toggle-sub">Allow automatic refunds for partial changes or cancellations.</div>
              </div>
              <label className="cm-switch">
                <input
                  type="checkbox"
                  name="allowPartialRefunds"
                  checked={allowPartialRefunds}
                  onChange={(e) => setAllowPartialRefunds(e.target.checked)}
                />
                <span className="cm-slider" />
              </label>
            </div>
          </div>
        </div>

        {/* Bottom Action Buttons */}
        <div className="cm-rules-footer">
          <button
            type="button"
            onClick={handleReset}
            className="cm-btn-secondary"
          >
            Discard changes
          </button>
          <button
            type="submit"
            disabled={isSaving}
            className="cm-btn-primary"
            style={{ width: "auto", minWidth: "110px", padding: "7px 20px" }}
          >
            {isSaving ? "Saving..." : "Save rules"}
          </button>
        </div>
      </fetcher.Form>

      {/* Comprehensive 5-Step Storefront Customer Experience Preview */}
      {isPreviewOpen && (
        <div className="cm-sf-modal-overlay" onClick={() => setIsPreviewOpen(false)}>
          {/* Storefront Viewport Container */}
          <div className="cm-sf-viewport" onClick={(e) => e.stopPropagation()}>
            {/* 5-Step Horizontal Stepper (Steps 2 through 5) */}
            {sfStep > 1 && (
              <div className="cm-sf-progress-bar">
                <div style={{ display: "flex", alignItems: "center", flex: 1, marginRight: "16px" }}>
                  {[
                    { num: 1, title: "1. Access", sub: "Access granted" },
                    { num: 2, title: "2. Edit", sub: sfStep > 2 ? "Changes added" : "Make changes" },
                    { num: 3, title: "3. Review & Impact", sub: sfStep > 3 ? "Changes reviewed" : "See impact" },
                    { num: 4, title: "4. Payment / Refund", sub: sfStep > 4 ? "Payment completed" : "Pay or get refund" },
                    { num: 5, title: "5. Done", sub: "Order updated" },
                  ].map((st, idx, arr) => (
                    <div key={st.num} style={{ display: "contents" }}>
                      <div
                        className={`cm-sf-progress-step ${sfStep === st.num ? "active" : sfStep > st.num ? "completed" : ""}`}
                        onClick={() => setSfStep(st.num as 1 | 2 | 3 | 4 | 5)}
                      >
                        <div className="cm-sf-step-circle">
                          {sfStep > st.num ? "✓" : st.num}
                        </div>
                        <div>
                          <div>{st.title}</div>
                          <div style={{ fontSize: "10.5px", color: "#64748b", fontWeight: 400 }}>{st.sub}</div>
                        </div>
                      </div>
                      {idx < arr.length - 1 && (
                        <div className={`cm-sf-progress-connector ${sfStep > st.num ? "filled" : ""}`} />
                      )}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setIsPreviewOpen(false)}
                  style={{
                    background: "#f1f2f4",
                    border: "1px solid #cbd5e1",
                    color: "#1e293b",
                    fontSize: "12px",
                    fontWeight: 600,
                    padding: "5px 12px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  ✕ Close
                </button>
              </div>
            )}

            {/* =========================================================================
                STEP 1: ACCESS YOUR ORDER (Screenshot 1)
                ========================================================================= */}
            {sfStep === 1 && (
              <div className="cm-sf-body">
                {/* Top Success Banner with Close Button */}
                <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: "#008060", color: "#ffffff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "13px", flexShrink: 0 }}>✓</div>
                    <div>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: "#14532d" }}>Great! You can make changes to this order.</div>
                      <div style={{ fontSize: "12px", color: "#166534" }}>Review the details below and continue to edit eligible parts.</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span style={{ fontSize: "12px", color: "#15803d", display: "flex", alignItems: "center", gap: "4px" }}>
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
                      Need help?
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsPreviewOpen(false)}
                      style={{
                        background: "#ffffff",
                        border: "1px solid #bbf7d0",
                        color: "#14532d",
                        fontSize: "12px",
                        fontWeight: 600,
                        padding: "4px 10px",
                        borderRadius: "6px",
                        cursor: "pointer",
                      }}
                    >
                      ✕ Close
                    </button>
                  </div>
                </div>

                <div className="cm-sf-access-grid">
                  {/* Left Column: Access Verification Card */}
                  <div className="cm-sf-card">
                    <div style={{ width: "36px", height: "36px", borderRadius: "50%", background: "#e8f5e9", color: "#008060", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "12px" }}>
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>
                    </div>
                    <h2 style={{ fontSize: "16px", fontWeight: 700, margin: "0 0 4px 0", color: "#1e293b" }}>Access your order</h2>
                    <p style={{ fontSize: "12px", color: "#64748b", margin: "0 0 16px 0" }}>Let's verify a few details to securely load your order.</p>

                    <div className="cm-sf-input-group">
                      <label>Order number</label>
                      <div style={{ position: "relative" }}>
                        <input type="text" defaultValue="#10482" readOnly style={{ paddingRight: "32px", background: "#ffffff" }} />
                        <span style={{ position: "absolute", right: "10px", top: "8px", color: "#008060", fontWeight: 700 }}>✓</span>
                      </div>
                    </div>

                    <div className="cm-sf-input-group">
                      <label>Email address</label>
                      <div style={{ position: "relative" }}>
                        <input type="text" defaultValue="vivek.chahar@email.com" readOnly style={{ paddingRight: "32px", background: "#ffffff" }} />
                        <span style={{ position: "absolute", right: "10px", top: "8px", color: "#008060", fontWeight: 700 }}>✓</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setSfStep(2)}
                      className="cm-btn-primary"
                      style={{ marginTop: "12px", padding: "10px 0" }}
                    >
                      View my order →
                    </button>

                    <div style={{ fontSize: "11px", color: "#64748b", marginTop: "12px", display: "flex", alignItems: "center", gap: "6px" }}>
                      <span>🔒</span>
                      <span>This link is unique to you and this order. It will not work for others.</span>
                    </div>

                    <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "10px 12px", marginTop: "16px", display: "flex", gap: "10px", alignItems: "center" }}>
                      <div style={{ color: "#008060" }}>🛡️</div>
                      <div style={{ fontSize: "11px", color: "#475569" }}>
                        <strong>Your information is safe.</strong> We use industry-standard encryption to keep your order information secure.
                      </div>
                    </div>
                  </div>

                  {/* Right Column: Order Details & Edit Capabilities */}
                  <div className="cm-sf-card">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span style={{ fontSize: "18px", fontWeight: 800, color: "#1e293b" }}>Order #10482</span>
                          <span className="cm-badge-completed">Confirmed</span>
                        </div>
                        <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>Placed on May 10, 2024 at 10:21 AM</div>
                      </div>
                      <button type="button" className="cm-btn-outline" style={{ fontSize: "11.5px", padding: "4px 8px" }}>View in store ↗</button>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px", padding: "12px 0", borderTop: "1px solid #f1f5f9", borderBottom: "1px solid #f1f5f9", fontSize: "11.5px" }}>
                      <div>
                        <div style={{ color: "#64748b", display: "flex", alignItems: "center", gap: "4px" }}>📅 Estimated delivery</div>
                        <div style={{ fontWeight: 600, color: "#1e293b", marginTop: "2px" }}>May 14 – May 16, 2024</div>
                        <div style={{ fontSize: "10.5px", color: "#94a3b8" }}>2–3 business days</div>
                      </div>
                      <div>
                        <div style={{ color: "#64748b", display: "flex", alignItems: "center", gap: "4px" }}>📍 Shipping to</div>
                        <div style={{ fontWeight: 600, color: "#1e293b", marginTop: "2px" }}>Vivek Chahar</div>
                        <div style={{ fontSize: "10.5px", color: "#94a3b8" }}>Sec-62, Noida, UP</div>
                      </div>
                      <div>
                        <div style={{ color: "#64748b", display: "flex", alignItems: "center", gap: "4px" }}>💳 Payment method</div>
                        <div style={{ fontWeight: 600, color: "#1e293b", marginTop: "2px" }}>Visa •••• 4242</div>
                        <div style={{ fontSize: "10.5px", color: "#008060", fontWeight: 600 }}>Paid ₹3,149.00</div>
                      </div>
                    </div>

                    {/* Edit Window Banner */}
                    <div style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: "8px", padding: "10px 14px", margin: "14px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: "12.5px", color: "#92400e", display: "flex", alignItems: "center", gap: "6px" }}>
                          <span>🕒</span> Edit window
                        </div>
                        <div style={{ fontSize: "11.5px", color: "#78350f" }}>You can edit this order until May 11, 2024 at 10:21 AM ({editWindowHours} {editWindowUnit.toLowerCase()} from order placement).</div>
                      </div>
                      <div style={{ textAlign: "right", background: "#ffffff", padding: "4px 8px", borderRadius: "6px", border: "1px solid #fde68a" }}>
                        <div style={{ fontSize: "13px", fontWeight: 800, color: "#92400e", fontFamily: "monospace" }}>
                          {formatTimer(secondsRemaining)}
                        </div>
                        <div style={{ fontSize: "9.5px", color: "#78350f" }}>Time remaining</div>
                      </div>
                    </div>

                    {/* What Can You Edit Pills (Dynamically filtered based on merchant rules) */}
                    <div style={{ margin: "16px 0" }}>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: "#1e293b", marginBottom: "8px" }}>What can you edit?</div>
                      {!allowAddressEdit && !allowItemSwap && !allowQuantityChange && !allowOrderCancellation ? (
                        <div style={{ fontSize: "12px", color: "#64748b", background: "#f8fafc", padding: "10px 14px", borderRadius: "6px", border: "1px dashed #cbd5e1" }}>
                          No edits are allowed for this order based on the store's rules.
                        </div>
                      ) : (
                        <div style={{ display: "grid", gridTemplateColumns: `repeat(${[allowAddressEdit, allowItemSwap, allowQuantityChange, allowOrderCancellation].filter(Boolean).length}, 1fr)`, gap: "8px", textAlign: "center" }}>
                          {allowAddressEdit && (
                            <div style={{ padding: "8px 4px", border: "1px solid #e2e8f0", borderRadius: "6px", background: "#f8fafc" }}>
                              <div style={{ fontSize: "14px" }}>📍</div>
                              <div style={{ fontSize: "11px", fontWeight: 600, color: "#1e293b" }}>Shipping address</div>
                              <span style={{ fontSize: "10px", color: "#15803d", background: "#dcfce7", padding: "1px 6px", borderRadius: "10px", fontWeight: 600 }}>Allowed</span>
                            </div>
                          )}
                          {allowItemSwap && (
                            <div style={{ padding: "8px 4px", border: "1px solid #e2e8f0", borderRadius: "6px", background: "#f8fafc" }}>
                              <div style={{ fontSize: "14px" }}>📦</div>
                              <div style={{ fontSize: "11px", fontWeight: 600, color: "#1e293b" }}>Items &amp; variants</div>
                              <span style={{ fontSize: "10px", color: "#15803d", background: "#dcfce7", padding: "1px 6px", borderRadius: "10px", fontWeight: 600 }}>Allowed</span>
                            </div>
                          )}
                          {allowQuantityChange && (
                            <div style={{ padding: "8px 4px", border: "1px solid #e2e8f0", borderRadius: "6px", background: "#f8fafc" }}>
                              <div style={{ fontSize: "14px" }}>#</div>
                              <div style={{ fontSize: "11px", fontWeight: 600, color: "#1e293b" }}>Quantity</div>
                              <span style={{ fontSize: "10px", color: "#15803d", background: "#dcfce7", padding: "1px 6px", borderRadius: "10px", fontWeight: 600 }}>Allowed</span>
                            </div>
                          )}
                          {allowOrderCancellation && (
                            <div style={{ padding: "8px 4px", border: "1px solid #e2e8f0", borderRadius: "6px", background: "#f8fafc" }}>
                              <div style={{ fontSize: "14px" }}>❌</div>
                              <div style={{ fontSize: "11px", fontWeight: 600, color: "#1e293b" }}>Cancel order</div>
                              <span style={{ fontSize: "10px", color: "#15803d", background: "#dcfce7", padding: "1px 6px", borderRadius: "10px", fontWeight: 600 }}>Allowed</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Order Items */}
                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "12px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                        <span style={{ fontSize: "13px", fontWeight: 700 }}>Order items (2)</span>
                        <span style={{ fontSize: "11px", color: "#6366f1", background: "#e0e7ff", padding: "2px 8px", borderRadius: "12px", fontWeight: 600 }}>Partially fulfilled (1/2)</span>
                      </div>

                      <div className="cm-sf-item-row">
                        <div className="cm-sf-item-img">👕</div>
                        <div className="cm-sf-item-info">
                          <div className="cm-sf-item-name">Classic Black T-shirt</div>
                          <div className="cm-sf-item-meta">Size: M | Qty: 1</div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontWeight: 700, fontSize: "13px" }}>₹1,499.00</div>
                          <span style={{ fontSize: "10.5px", color: "#6366f1", background: "#e0e7ff", padding: "1px 6px", borderRadius: "10px", fontWeight: 600 }}>Fulfilled</span>
                          <div style={{ fontSize: "10.5px", color: "#94a3b8" }}>This item can't be changed</div>
                        </div>
                      </div>

                      <div className="cm-sf-item-row" style={{ borderBottom: "none" }}>
                        <div className="cm-sf-item-img">👟</div>
                        <div className="cm-sf-item-info">
                          <div className="cm-sf-item-name">White Sneakers</div>
                          <div className="cm-sf-item-meta">Size: 8 | Qty: {sneakersQty}</div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontWeight: 700, fontSize: "13px" }}>₹1,650.00</div>
                          <span style={{ fontSize: "10.5px", color: "#d97706", background: "#fef3c7", padding: "1px 6px", borderRadius: "10px", fontWeight: 600 }}>Unfulfilled</span>
                          <div style={{ fontSize: "10.5px", color: "#008060" }}>You can edit this item</div>
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "16px", paddingTop: "12px", borderTop: "1px solid #f1f5f9" }}>
                      <span style={{ fontSize: "11.5px", color: "#64748b" }}>ℹ️ Next, you can make changes to the eligible parts of your order.</span>
                      <button
                        type="button"
                        onClick={() => setSfStep(2)}
                        className="cm-btn-primary"
                        style={{ width: "auto", padding: "8px 20px" }}
                      >
                        Continue to edit order →
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* =========================================================================
                STEP 2: EDIT YOUR ORDER (Screenshot 2)
                ========================================================================= */}
            {sfStep === 2 && (
              <div className="cm-sf-body">
                {/* Order Status Banner */}
                <div className="cm-sf-order-header-card">
                  <div className="cm-sf-order-title-group">
                    <div className="cm-sf-order-icon">🛍️</div>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "17px", fontWeight: 800, color: "#1e293b" }}>Order #10482</span>
                        <span className="cm-badge-completed">Confirmed</span>
                      </div>
                      <div style={{ fontSize: "12px", color: "#64748b" }}>From Summer Store • Placed on May 10, 2024 at 10:21 AM</div>
                    </div>
                  </div>
                  <div className="cm-sf-timer-pill">
                    <div style={{ fontSize: "11px", color: "#78350f" }}>Edit window closes in</div>
                    <div className="cm-sf-timer-val">{formatTimer(secondsRemaining)}</div>
                    <div style={{ fontSize: "9.5px", color: "#92400e" }}>({editWindowHours} {editWindowUnit.toLowerCase()} from order placement)</div>
                  </div>
                </div>

                <div style={{ marginBottom: "16px" }}>
                  <h2 style={{ fontSize: "18px", fontWeight: 800, margin: "0 0 4px 0", color: "#1e293b" }}>Edit your order</h2>
                  <p style={{ fontSize: "12.5px", color: "#64748b", margin: 0 }}>Select what you'd like to change. Only eligible parts of your order can be edited.</p>
                </div>

                {/* 5 Selectable Edit Action Cards */}
                <div className="cm-sf-actions-grid">
                  <div
                    className={`cm-sf-action-card ${sfTab === "address" ? "active" : ""}`}
                    onClick={() => setSfTab("address")}
                  >
                    <div className="cm-sf-action-radio">{sfTab === "address" ? "✓" : ""}</div>
                    <div className="cm-sf-action-icon">📍</div>
                    <div className="cm-sf-action-title">Shipping address</div>
                    <div className="cm-sf-action-sub">Change where your order will be delivered</div>
                  </div>

                  <div
                    className={`cm-sf-action-card ${sfTab === "items" ? "active" : ""}`}
                    onClick={() => setSfTab("items")}
                  >
                    <div className="cm-sf-action-radio">{sfTab === "items" ? "✓" : ""}</div>
                    <div className="cm-sf-action-icon">📦</div>
                    <div className="cm-sf-action-title">Items or variants</div>
                    <div className="cm-sf-action-sub">Change product, size, color or variant</div>
                  </div>

                  <div
                    className={`cm-sf-action-card ${sfTab === "quantity" ? "active" : ""}`}
                    onClick={() => setSfTab("quantity")}
                  >
                    <div className="cm-sf-action-radio">{sfTab === "quantity" ? "✓" : ""}</div>
                    <div className="cm-sf-action-icon">#</div>
                    <div className="cm-sf-action-title">Quantity</div>
                    <div className="cm-sf-action-sub">Change the quantity of items</div>
                  </div>

                  <div
                    className={`cm-sf-action-card ${sfTab === "cancel" ? "active" : ""}`}
                    onClick={() => setSfTab("cancel")}
                  >
                    <div className="cm-sf-action-radio">{sfTab === "cancel" ? "✓" : ""}</div>
                    <div className="cm-sf-action-icon" style={{ color: "#dc2626" }}>❌</div>
                    <div className="cm-sf-action-title">Cancel order</div>
                    <div className="cm-sf-action-sub">Cancel the entire order or specific items</div>
                  </div>

                  <div className="cm-sf-action-card disabled">
                    <div className="cm-sf-action-icon">🔒</div>
                    <div className="cm-sf-action-title">Payment method</div>
                    <div className="cm-sf-action-sub">Not allowed to change</div>
                  </div>
                </div>

                {/* Form and Order Items Grid */}
                <div className="cm-sf-layout-grid">
                  {/* Left Column Form */}
                  <div className="cm-sf-card">
                    {sfTab === "address" && (
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
                          <div>
                            <h3 style={{ fontSize: "14px", fontWeight: 700, margin: "0 0 2px 0" }}>Update shipping address</h3>
                            <div style={{ fontSize: "12px", color: "#64748b" }}>Enter the new shipping address.</div>
                          </div>
                          <span style={{ fontSize: "11px", color: "#15803d", background: "#dcfce7", padding: "2px 8px", borderRadius: "12px", fontWeight: 600 }}>✓ Good news!</span>
                        </div>

                        <div style={{ fontSize: "11.5px", color: "#64748b", background: "#f8fafc", padding: "6px 10px", borderRadius: "6px", marginBottom: "14px" }}>
                          Your order is not yet fulfilled. You can update the shipping address.
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                          <div className="cm-sf-input-group">
                            <label>Full name</label>
                            <input
                              type="text"
                              value={sfAddress.fullName}
                              onChange={(e) => setSfAddress({ ...sfAddress, fullName: e.target.value })}
                            />
                          </div>
                          <div className="cm-sf-input-group">
                            <label>Phone (optional)</label>
                            <input
                              type="text"
                              value={sfAddress.phone}
                              onChange={(e) => setSfAddress({ ...sfAddress, phone: e.target.value })}
                            />
                          </div>
                        </div>

                        <div className="cm-sf-input-group">
                          <label>Address</label>
                          <input
                            type="text"
                            value={sfAddress.address}
                            onChange={(e) => setSfAddress({ ...sfAddress, address: e.target.value })}
                          />
                        </div>

                        <div className="cm-sf-input-group">
                          <label>Apartment, suite, etc. (optional)</label>
                          <input
                            type="text"
                            value={sfAddress.apartment}
                            onChange={(e) => setSfAddress({ ...sfAddress, apartment: e.target.value })}
                          />
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px" }}>
                          <div className="cm-sf-input-group">
                            <label>City</label>
                            <input
                              type="text"
                              value={sfAddress.city}
                              onChange={(e) => setSfAddress({ ...sfAddress, city: e.target.value })}
                            />
                          </div>
                          <div className="cm-sf-input-group">
                            <label>State / Province</label>
                            <select
                              value={sfAddress.province}
                              onChange={(e) => setSfAddress({ ...sfAddress, province: e.target.value })}
                            >
                              <option value="Uttar Pradesh">Uttar Pradesh</option>
                              <option value="Delhi">Delhi</option>
                              <option value="Haryana">Haryana</option>
                              <option value="Maharashtra">Maharashtra</option>
                              <option value="Karnataka">Karnataka</option>
                            </select>
                          </div>
                          <div className="cm-sf-input-group">
                            <label>PIN / ZIP code</label>
                            <input
                              type="text"
                              value={sfAddress.zip}
                              onChange={(e) => setSfAddress({ ...sfAddress, zip: e.target.value })}
                            />
                          </div>
                        </div>

                        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "#475569", cursor: "pointer", marginTop: "8px" }}>
                          <input
                            type="checkbox"
                            checked={sfAddress.isDefault}
                            onChange={(e) => setSfAddress({ ...sfAddress, isDefault: e.target.checked })}
                            style={{ accentColor: "#008060" }}
                          />
                          <span>Save this as my default address</span>
                        </label>
                      </div>
                    )}

                    {sfTab === "quantity" && (
                      <div>
                        <h3 style={{ fontSize: "14px", fontWeight: 700, margin: "0 0 2px 0" }}>Update item quantities</h3>
                        <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "14px" }}>Adjust the quantity of unfulfilled items in your order.</div>

                        <div style={{ padding: "12px", border: "1px solid #e2e8f0", borderRadius: "8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: "13.5px" }}>White Sneakers</div>
                            <div style={{ fontSize: "11.5px", color: "#64748b" }}>Size: 8 • ₹1,650.00 each</div>
                          </div>
                          <div className="cm-sf-qty-ctrl">
                            <button type="button" className="cm-sf-qty-btn" onClick={() => setSneakersQty(Math.max(1, sneakersQty - 1))}>−</button>
                            <span className="cm-sf-qty-val">{sneakersQty}</span>
                            <button type="button" className="cm-sf-qty-btn" onClick={() => setSneakersQty(sneakersQty + 1)}>+</button>
                          </div>
                        </div>
                      </div>
                    )}

                    {sfTab === "items" && (
                      <div>
                        <h3 style={{ fontSize: "14px", fontWeight: 700, margin: "0 0 2px 0" }}>Change Item Size / Variant</h3>
                        <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "14px" }}>Select a replacement variant for unfulfilled items.</div>

                        <div style={{ padding: "12px", border: "1px solid #e2e8f0", borderRadius: "8px" }}>
                          <div style={{ fontWeight: 700, fontSize: "13.5px", marginBottom: "8px" }}>White Sneakers</div>
                          <div className="cm-sf-input-group">
                            <label>Select Size</label>
                            <select defaultValue="8">
                              <option value="7">Size 7 (In stock)</option>
                              <option value="8">Size 8 (Current)</option>
                              <option value="9">Size 9 (In stock)</option>
                              <option value="10">Size 10 (In stock)</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    )}

                    {sfTab === "cancel" && (
                      <div>
                        <h3 style={{ fontSize: "14px", fontWeight: 700, margin: "0 0 2px 0", color: "#dc2626" }}>Cancel Order</h3>
                        <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "14px" }}>Cancellations are processed immediately according to store policy.</div>

                        <div className="cm-sf-input-group">
                          <label>Reason for cancellation</label>
                          <select value={cancelReason} onChange={(e) => setCancelReason(e.target.value)}>
                            <option value="Order created by mistake">Order created by mistake</option>
                            <option value="Found a better price elsewhere">Found a better price elsewhere</option>
                            <option value="Delivery time is too long">Delivery time is too long</option>
                            <option value="Other">Other</option>
                          </select>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Right Column: Order Items & Summary */}
                  <div className="cm-sf-card">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                      <span style={{ fontSize: "13px", fontWeight: 700 }}>Order items (2)</span>
                      <span style={{ fontSize: "11px", color: "#6366f1", background: "#e0e7ff", padding: "2px 8px", borderRadius: "12px", fontWeight: 600 }}>Partially fulfilled (1/2)</span>
                    </div>

                    <div className="cm-sf-item-row">
                      <div className="cm-sf-item-img">👕</div>
                      <div className="cm-sf-item-info">
                        <div className="cm-sf-item-name">Classic Black T-shirt</div>
                        <div className="cm-sf-item-meta">Size: M | Qty: 1</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontWeight: 700, fontSize: "13px" }}>₹1,499.00</div>
                        <span style={{ fontSize: "10.5px", color: "#6366f1", background: "#e0e7ff", padding: "1px 6px", borderRadius: "10px", fontWeight: 600 }}>Fulfilled</span>
                        <div style={{ fontSize: "10.5px", color: "#94a3b8" }}>This item can't be changed</div>
                      </div>
                    </div>

                    <div className="cm-sf-item-row" style={{ borderBottom: "none" }}>
                      <div className="cm-sf-item-img">👟</div>
                      <div className="cm-sf-item-info">
                        <div className="cm-sf-item-name">White Sneakers</div>
                        <div className="cm-sf-item-meta">Size: 8 | Qty: {sneakersQty}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontWeight: 700, fontSize: "13px" }}>₹{1650 * sneakersQty}.00</div>
                        <span style={{ fontSize: "10.5px", color: "#d97706", background: "#fef3c7", padding: "1px 6px", borderRadius: "10px", fontWeight: 600 }}>Unfulfilled</span>
                        <div style={{ fontSize: "10.5px", color: (allowQuantityChange || allowItemSwap) ? "#008060" : "#64748b" }}>
                          {(allowQuantityChange || allowItemSwap) ? "You can edit this item" : "Item changes not allowed"}
                        </div>
                      </div>
                    </div>

                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "12px", marginTop: "12px" }}>
                      <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "8px" }}>Order summary</div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12.5px", color: "#64748b", marginBottom: "4px" }}>
                        <span>Subtotal</span>
                        <span style={{ fontWeight: 600, color: "#1e293b" }}>₹{1499 + 1650 * sneakersQty}.00</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12.5px", color: "#64748b", marginBottom: "4px" }}>
                        <span>Shipping</span>
                        <span style={{ fontWeight: 600, color: "#008060" }}>Free</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12.5px", color: "#64748b", marginBottom: "4px" }}>
                        <span>Tax</span>
                        <span style={{ fontWeight: 600, color: "#1e293b" }}>₹0.00</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px", fontWeight: 800, color: "#1e293b", borderTop: "1px solid #f1f5f9", paddingTop: "8px", marginTop: "6px" }}>
                        <span>Order total</span>
                        <span>₹{1499 + 1650 * sneakersQty}.00</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Bottom Action Nav */}
                <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: "12px", color: "#64748b", display: "flex", alignItems: "center", gap: "6px" }}>
                    <span>ℹ️</span> Some items in your order are already fulfilled and can't be changed. <span style={{ color: "#008060", cursor: "pointer", fontWeight: 600 }}>View details →</span>
                  </div>
                  <div style={{ display: "flex", gap: "10px" }}>
                    <button type="button" onClick={() => setSfStep(1)} className="cm-btn-outline">← Back</button>
                    <button
                      type="button"
                      disabled={!allowAddressEdit && !allowItemSwap && !allowQuantityChange && !allowOrderCancellation}
                      onClick={() => setSfStep(3)}
                      className="cm-btn-primary"
                      style={{
                        width: "auto",
                        padding: "8px 20px",
                        opacity: (!allowAddressEdit && !allowItemSwap && !allowQuantityChange && !allowOrderCancellation) ? 0.5 : 1,
                        cursor: (!allowAddressEdit && !allowItemSwap && !allowQuantityChange && !allowOrderCancellation) ? "not-allowed" : "pointer",
                      }}
                    >
                      {(!allowAddressEdit && !allowItemSwap && !allowQuantityChange && !allowOrderCancellation) ? "Edits disabled" : "Continue to review →"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* =========================================================================
                STEP 3: REVIEW YOUR CHANGES (Screenshot 3)
                ========================================================================= */}
            {sfStep === 3 && (
              <div className="cm-sf-body">
                {/* Order Status Banner */}
                <div className="cm-sf-order-header-card">
                  <div className="cm-sf-order-title-group">
                    <div className="cm-sf-order-icon">🛍️</div>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "17px", fontWeight: 800, color: "#1e293b" }}>Order #10482</span>
                        <span className="cm-badge-completed">Confirmed</span>
                      </div>
                      <div style={{ fontSize: "12px", color: "#64748b" }}>From Summer Store • Placed on May 10, 2024 at 10:21 AM</div>
                    </div>
                  </div>
                  <div className="cm-sf-timer-pill">
                    <div style={{ fontSize: "11px", color: "#78350f" }}>Edit window closes in</div>
                    <div className="cm-sf-timer-val">{formatTimer(secondsRemaining)}</div>
                    <div style={{ fontSize: "9.5px", color: "#92400e" }}>({editWindowHours} {editWindowUnit.toLowerCase()} from order placement)</div>
                  </div>
                </div>

                <div style={{ marginBottom: "16px" }}>
                  <h2 style={{ fontSize: "18px", fontWeight: 800, margin: "0 0 4px 0", color: "#1e293b" }}>Review your changes</h2>
                  <p style={{ fontSize: "12.5px", color: "#64748b", margin: 0 }}>Please review the changes and see how they impact your order.</p>
                </div>

                <div className="cm-sf-layout-grid">
                  {/* Left Column: Items Comparison Table */}
                  <div className="cm-sf-card">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                      <span style={{ fontSize: "14px", fontWeight: 700 }}>Order items</span>
                      <div style={{ display: "flex", gap: "40px", fontSize: "12px", color: "#64748b", fontWeight: 600 }}>
                        <span>Original</span>
                        <span>Updated</span>
                      </div>
                    </div>

                    <div className="cm-sf-item-row">
                      <div className="cm-sf-item-img">👕</div>
                      <div className="cm-sf-item-info">
                        <div className="cm-sf-item-name">Classic Black T-shirt</div>
                        <div className="cm-sf-item-meta">Size: M | Qty: 1</div>
                        <span style={{ fontSize: "10.5px", color: "#6366f1", background: "#e0e7ff", padding: "1px 6px", borderRadius: "10px", fontWeight: 600 }}>Fulfilled</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "30px", fontSize: "12.5px" }}>
                        <div>
                          <div style={{ fontWeight: 600 }}>₹1,499.00</div>
                          <div style={{ fontSize: "11px", color: "#94a3b8" }}>Qty: 1</div>
                        </div>
                        <div>
                          <div style={{ fontWeight: 600 }}>₹1,499.00</div>
                          <div style={{ fontSize: "11px", color: "#94a3b8" }}>Qty: 1</div>
                        </div>
                        <span style={{ fontSize: "11.5px", color: "#64748b" }}>No change</span>
                      </div>
                    </div>

                    <div className="cm-sf-item-row" style={{ borderBottom: "none" }}>
                      <div className="cm-sf-item-img">👟</div>
                      <div className="cm-sf-item-info">
                        <div className="cm-sf-item-name">White Sneakers</div>
                        <div className="cm-sf-item-meta">Size: 8 | Qty: 1</div>
                        <span style={{ fontSize: "10.5px", color: "#d97706", background: "#fef3c7", padding: "1px 6px", borderRadius: "10px", fontWeight: 600 }}>Unfulfilled</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "30px", fontSize: "12.5px" }}>
                        <div>
                          <div style={{ fontWeight: 600 }}>₹1,650.00</div>
                          <div style={{ fontSize: "11px", color: "#94a3b8" }}>Qty: 1</div>
                        </div>
                        <div>
                          <div style={{ fontWeight: 600 }}>₹1,650.00</div>
                          <div style={{ fontSize: "11px", color: "#94a3b8" }}>Qty: {sneakersQty}</div>
                        </div>
                        <span style={{ fontSize: "12px", color: "#008060", fontWeight: 700 }}>+ ₹{(sneakersQty - 1) * 1650}.00</span>
                      </div>
                    </div>

                    <div style={{ background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: "6px", padding: "8px 12px", margin: "14px 0", fontSize: "12px", color: "#475569", display: "flex", alignItems: "center", gap: "6px" }}>
                      <span style={{ color: "#008060", fontWeight: 700 }}>+</span> You have made changes to your order. Please review the impact on the right.
                    </div>

                    {/* Change Summary Box */}
                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "14px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                        <span style={{ fontSize: "13px", fontWeight: 700 }}>Change summary</span>
                        <button type="button" onClick={() => setSfStep(2)} style={{ border: "none", background: "none", color: "#008060", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
                          ✎ Edit changes
                        </button>
                      </div>
                      <div style={{ background: "#f0fdf4", border: "1px solid #dcfce7", borderRadius: "6px", padding: "10px 12px", fontSize: "12px", color: "#166534", display: "flex", flexDirection: "column", gap: "6px" }}>
                        <div>📍 <strong>Shipping address updated</strong> to {sfAddress.address}, {sfAddress.apartment}, {sfAddress.city}</div>
                        <div># <strong>Quantity updated</strong> for White Sneakers (1 → {sneakersQty})</div>
                      </div>
                    </div>
                  </div>

                  {/* Right Column: Financial Impact */}
                  <div className="cm-sf-card">
                    <h3 style={{ fontSize: "15px", fontWeight: 800, margin: "0 0 2px 0", color: "#1e293b" }}>Financial impact</h3>
                    <p style={{ fontSize: "12px", color: "#64748b", margin: "0 0 14px 0" }}>Here's how these changes affect your order.</p>

                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12.5px", color: "#64748b", marginBottom: "6px" }}>
                      <span>Original order total</span>
                      <span style={{ fontWeight: 600, color: "#1e293b" }}>₹3,149.00</span>
                    </div>

                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "8px", marginTop: "8px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12.5px", color: "#64748b", marginBottom: "4px" }}>
                        <span>Subtotal (2 items)</span>
                        <span style={{ fontWeight: 600, color: "#1e293b" }}>₹3,149.00</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12.5px", color: "#64748b", marginBottom: "4px" }}>
                        <span>Shipping</span>
                        <span style={{ fontWeight: 600, color: "#008060" }}>Free</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12.5px", color: "#64748b", marginBottom: "4px" }}>
                        <span>Tax</span>
                        <span style={{ fontWeight: 600, color: "#1e293b" }}>₹0.00</span>
                      </div>
                    </div>

                    {/* Additional Amount Due Box */}
                    <div className="cm-sf-impact-box">
                      <div className="cm-sf-impact-row">
                        <span style={{ fontWeight: 700, color: "#15803d" }}>Additional amount due</span>
                        <span style={{ fontWeight: 800, color: "#15803d", fontSize: "14px" }}>+ ₹{(sneakersQty - 1) * 1650}.00</span>
                      </div>
                      <div className="cm-sf-impact-total">
                        <span>New order total</span>
                        <span>₹{3149 + (sneakersQty - 1) * 1650}.00</span>
                      </div>
                      <div style={{ fontSize: "10.5px", color: "#166534", marginTop: "4px" }}>Includes tax</div>
                    </div>

                    <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "8px 10px", fontSize: "11.5px", color: "#64748b", display: "flex", alignItems: "center", gap: "6px" }}>
                      <span>ℹ️</span> You'll be asked to pay the additional amount in the next step.
                    </div>
                  </div>
                </div>

                {/* Bottom Action Nav */}
                <div className="cm-sf-nav-bar">
                  <button type="button" onClick={() => setSfStep(2)} className="cm-btn-outline">← Back</button>
                  <button type="button" onClick={() => setSfStep(4)} className="cm-btn-primary" style={{ width: "auto", padding: "8px 24px" }}>
                    Continue to payment →
                  </button>
                </div>
              </div>
            )}

            {/* =========================================================================
                STEP 4: PAYMENT / REFUND (Screenshot 4)
                ========================================================================= */}
            {sfStep === 4 && (
              <div className="cm-sf-body">
                {/* Order Status Banner */}
                <div className="cm-sf-order-header-card">
                  <div className="cm-sf-order-title-group">
                    <div className="cm-sf-order-icon">🛍️</div>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "17px", fontWeight: 800, color: "#1e293b" }}>Order #10482</span>
                        <span className="cm-badge-completed">Confirmed</span>
                      </div>
                      <div style={{ fontSize: "12px", color: "#64748b" }}>From Summer Store • Placed on May 10, 2024 at 10:21 AM</div>
                    </div>
                  </div>
                  <div className="cm-sf-timer-pill">
                    <div style={{ fontSize: "11px", color: "#78350f" }}>Edit window closes in</div>
                    <div className="cm-sf-timer-val">{formatTimer(secondsRemaining)}</div>
                    <div style={{ fontSize: "9.5px", color: "#92400e" }}>({editWindowHours} {editWindowUnit.toLowerCase()} from order placement)</div>
                  </div>
                </div>

                <div style={{ marginBottom: "16px" }}>
                  <h2 style={{ fontSize: "18px", fontWeight: 800, margin: "0 0 4px 0", color: "#1e293b" }}>Payment / Refund</h2>
                  <p style={{ fontSize: "12.5px", color: "#64748b", margin: 0 }}>To apply the changes to your order, you need to complete the payment or confirm the refund.</p>
                </div>

                <div className="cm-sf-layout-grid">
                  {/* Left Column: Payment Required Card */}
                  <div className="cm-sf-card">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <h3 style={{ fontSize: "15px", fontWeight: 800, margin: 0 }}>Payment required</h3>
                        <span style={{ fontSize: "11px", color: "#b45309", background: "#fef3c7", padding: "2px 8px", borderRadius: "12px", fontWeight: 600 }}>Additional amount due</span>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: "10.5px", color: "#64748b" }}>Amount due</div>
                        <div style={{ fontSize: "16px", fontWeight: 800, color: "#1e293b" }}>₹{(sneakersQty - 1) * 1650}.00</div>
                        <div style={{ fontSize: "9.5px", color: "#94a3b8" }}>Includes tax</div>
                      </div>
                    </div>

                    <p style={{ fontSize: "12px", color: "#64748b", margin: "0 0 16px 0" }}>An additional amount is due to apply your changes.</p>

                    {/* Shopify Secure Payment Card */}
                    <div className="cm-sf-payment-card">
                      <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                        <div style={{ width: "36px", height: "36px", borderRadius: "50%", background: "#f0fdf4", color: "#008060", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          🔒
                        </div>
                        <div>
                          <div style={{ fontSize: "13.5px", fontWeight: 700, color: "#1e293b" }}>Complete payment securely</div>
                          <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "2px", lineHeight: 1.4 }}>
                            You will be redirected to a secure payment page powered by Shopify to complete your payment. CartMend does not store or process your payment details.
                          </div>
                        </div>
                      </div>

                      <div className="cm-sf-payment-mock-screen">
                        <span style={{ fontSize: "28px" }}>🛍️</span>
                        <div style={{ position: "absolute", bottom: "-6px", right: "-6px", background: "#008060", color: "#ffffff", width: "18px", height: "18px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", fontWeight: 700 }}>✓</div>
                      </div>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: "#f0fdf4", border: "1px solid #dcfce7", borderRadius: "6px", fontSize: "11.5px", color: "#166534", marginBottom: "12px" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>🛡️ Your payment information is secure and encrypted.</span>
                      <span style={{ fontWeight: 600 }}>🔒 Secure Shopify payment</span>
                    </div>

                    <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "8px 12px", fontSize: "11.5px", color: "#64748b", display: "flex", alignItems: "center", gap: "6px" }}>
                      <span>ℹ️</span> Once your payment is successful, your order will be updated and you'll receive a confirmation email.
                    </div>
                  </div>

                  {/* Right Column: Order Summary & Explainer */}
                  <div className="cm-sf-card">
                    <h3 style={{ fontSize: "14px", fontWeight: 700, margin: "0 0 10px 0" }}>Order summary</h3>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12.5px", color: "#64748b", marginBottom: "6px" }}>
                      <span>Original order total</span>
                      <span style={{ fontWeight: 600, color: "#1e293b" }}>₹3,149.00</span>
                    </div>

                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "8px", marginTop: "8px" }}>
                      <div style={{ fontSize: "12px", fontWeight: 600, color: "#1e293b", marginBottom: "4px" }}>Changes</div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "#64748b", marginBottom: "4px" }}>
                        <span>Quantity updated for White Sneakers (1 → {sneakersQty})</span>
                        <span style={{ fontWeight: 600, color: "#008060" }}>+ ₹{(sneakersQty - 1) * 1650}.00</span>
                      </div>
                    </div>

                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "10px", marginTop: "8px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "15px", fontWeight: 800, color: "#1e293b" }}>
                        <span>New order total</span>
                        <span>₹{3149 + (sneakersQty - 1) * 1650}.00</span>
                      </div>
                      <div style={{ fontSize: "10.5px", color: "#94a3b8", marginTop: "2px" }}>Includes tax</div>
                    </div>

                    {/* Why is payment required? callout */}
                    <div style={{ background: "#f0fdf4", border: "1px solid #dcfce7", borderRadius: "8px", padding: "12px", marginTop: "16px" }}>
                      <div style={{ fontWeight: 700, fontSize: "12px", color: "#166534", display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                        <span>🏷️</span> Why is payment required?
                      </div>
                      <div style={{ fontSize: "11.5px", color: "#15803d", lineHeight: 1.35 }}>
                        You've made changes that increase the order total. An additional amount is due to update your order.
                      </div>
                    </div>
                  </div>
                </div>

                {/* Bottom Action Nav */}
                <div className="cm-sf-nav-bar">
                  <button type="button" onClick={() => setSfStep(3)} className="cm-btn-outline">← Back</button>
                  <div style={{ textAlign: "right" }}>
                    <button
                      type="button"
                      onClick={() => setSfStep(5)}
                      className="cm-btn-primary"
                      style={{ width: "auto", padding: "8px 24px", display: "inline-flex", alignItems: "center", gap: "6px" }}
                    >
                      <span>🔒</span> Continue to secure payment →
                    </button>
                    <div style={{ fontSize: "10.5px", color: "#64748b", marginTop: "3px" }}>You will be redirected to Shopify to complete payment</div>
                  </div>
                </div>
              </div>
            )}

            {/* =========================================================================
                STEP 5: DONE / ORDER UPDATED (Screenshot 5)
                ========================================================================= */}
            {sfStep === 5 && (
              <div className="cm-sf-body">
                {/* Order Status Banner */}
                <div className="cm-sf-order-header-card">
                  <div className="cm-sf-order-title-group">
                    <div className="cm-sf-order-icon">🛍️</div>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "17px", fontWeight: 800, color: "#1e293b" }}>Order #10482</span>
                        <span className="cm-badge-completed">Updated</span>
                      </div>
                      <div style={{ fontSize: "12px", color: "#64748b" }}>From Summer Store • Placed on May 10, 2024 at 10:21 AM</div>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", justifyContent: "flex-end" }}>
                      <span style={{ fontSize: "12px", color: "#475569", fontWeight: 600 }}>Edit window closed</span>
                      <span style={{ fontSize: "11px", color: "#15803d", background: "#dcfce7", padding: "2px 8px", borderRadius: "10px", fontWeight: 600 }}>✓ Completed</span>
                    </div>
                    <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>May 10, 2024 at 10:48 AM</div>
                  </div>
                </div>

                {/* Hero Confirmation Banner */}
                <div className="cm-sf-success-hero">
                  <div className="cm-sf-check-circle">✓</div>
                  <h2 style={{ fontSize: "20px", fontWeight: 800, color: "#14532d", margin: "0 0 4px 0" }}>Your order has been updated!</h2>
                  <p style={{ fontSize: "13px", color: "#166534", margin: "0 0 14px 0" }}>Your changes have been successfully applied.</p>
                  <button type="button" className="cm-btn-outline" style={{ fontSize: "12px", padding: "6px 14px" }}>
                    📄 View updated order details
                  </button>
                </div>

                <div className="cm-sf-layout-grid">
                  {/* Left Column: What Was Updated & Summary */}
                  <div className="cm-sf-card">
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
                      <h3 style={{ fontSize: "14px", fontWeight: 700, margin: 0 }}>What was updated</h3>
                      <span style={{ fontSize: "11px", color: "#15803d", background: "#dcfce7", padding: "2px 8px", borderRadius: "12px", fontWeight: 600 }}>2 changes</span>
                    </div>

                    <div style={{ padding: "10px 12px", border: "1px solid #f1f5f9", borderRadius: "6px", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                      <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                        <span style={{ fontSize: "16px" }}>📍</span>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "12.5px" }}>Shipping address</div>
                          <div style={{ fontSize: "11.5px", color: "#64748b" }}>Updated to {sfAddress.address}, {sfAddress.apartment}, {sfAddress.city}, {sfAddress.province} {sfAddress.zip}</div>
                        </div>
                      </div>
                      <span className="cm-badge-completed" style={{ fontSize: "10.5px" }}>Updated</span>
                    </div>

                    <div style={{ padding: "10px 12px", border: "1px solid #f1f5f9", borderRadius: "6px", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                      <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                        <span style={{ fontSize: "16px" }}>#</span>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "12.5px" }}>Quantity for White Sneakers</div>
                          <div style={{ fontSize: "11.5px", color: "#64748b" }}>Changed from 1 to {sneakersQty}</div>
                        </div>
                      </div>
                      <span className="cm-badge-completed" style={{ fontSize: "10.5px" }}>Updated</span>
                    </div>

                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "12px" }}>
                      <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "8px" }}>Order summary (updated)</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr auto 1fr", alignItems: "center", textAlign: "center", background: "#f8fafc", padding: "12px", borderRadius: "8px" }}>
                        <div>
                          <div style={{ fontSize: "10.5px", color: "#64748b" }}>Original total</div>
                          <div style={{ fontWeight: 700, fontSize: "13px" }}>₹3,149.00</div>
                        </div>
                        <span style={{ color: "#94a3b8" }}>›</span>
                        <div>
                          <div style={{ fontSize: "10.5px", color: "#64748b" }}>Changes</div>
                          <div style={{ fontWeight: 700, fontSize: "13px", color: "#008060" }}>+ ₹{(sneakersQty - 1) * 1650}.00</div>
                        </div>
                        <span style={{ color: "#94a3b8" }}>›</span>
                        <div>
                          <div style={{ fontSize: "10.5px", color: "#64748b" }}>New order total</div>
                          <div style={{ fontWeight: 800, fontSize: "14px", color: "#1e293b" }}>₹{3149 + (sneakersQty - 1) * 1650}.00</div>
                        </div>
                      </div>
                    </div>

                    <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "8px 12px", fontSize: "11.5px", color: "#64748b", marginTop: "14px", display: "flex", alignItems: "center", gap: "6px" }}>
                      <span>ℹ️</span> A confirmation email with your updated order details has been sent to <strong>vivek.chahar@email.com</strong>
                    </div>
                  </div>

                  {/* Right Column: What Happens Next & Troubleshooting */}
                  <div>
                    <div className="cm-sf-card">
                      <h3 style={{ fontSize: "14px", fontWeight: 700, margin: "0 0 10px 0" }}>What happens next?</h3>

                      <div style={{ display: "flex", gap: "10px", alignItems: "flex-start", marginBottom: "12px" }}>
                        <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: "#f0fdf4", color: "#008060", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>📦</div>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "12.5px" }}>We've notified Summer Store</div>
                          <div style={{ fontSize: "11.5px", color: "#64748b" }}>The store has been notified about your updated order.</div>
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: "10px", alignItems: "flex-start", marginBottom: "12px" }}>
                        <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: "#f0fdf4", color: "#008060", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>🚚</div>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "12.5px" }}>Your order is being prepared</div>
                          <div style={{ fontSize: "11.5px", color: "#64748b" }}>You'll receive shipping updates via email.</div>
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                        <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: "#f0fdf4", color: "#008060", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>✉️</div>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "12.5px" }}>Need help?</div>
                          <div style={{ fontSize: "11.5px", color: "#64748b" }}>Contact Summer Store if you have any questions about your order.</div>
                        </div>
                      </div>
                    </div>

                    {/* Something Went Wrong Support Card */}
                    <div className="cm-sf-troubleshoot-card">
                      <div className="cm-sf-troubleshoot-title">Something went wrong?</div>
                      <div style={{ fontSize: "11px", color: "#7f1d1d" }}>If your order wasn't updated, here are some common reasons:</div>

                      <div className="cm-sf-troubleshoot-item">
                        <span>💳</span>
                        <div>
                          <strong>Payment failed</strong>: Your payment couldn't be processed. <span style={{ color: "#008060", cursor: "pointer", fontWeight: 600 }}>Try payment again</span>
                        </div>
                      </div>

                      <div className="cm-sf-troubleshoot-item">
                        <span>🕒</span>
                        <div>
                          <strong>Edit window expired</strong>: The edit window has closed. <span style={{ color: "#008060", cursor: "pointer", fontWeight: 600 }}>Contact store</span>
                        </div>
                      </div>

                      <div className="cm-sf-troubleshoot-item">
                        <span>⚠️</span>
                        <div>
                          <strong>Changes couldn't be applied</strong>: Some items may no longer be eligible. <span style={{ color: "#008060", cursor: "pointer", fontWeight: 600 }}>View details</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Bottom Action Nav */}
                <div className="cm-sf-nav-bar">
                  <button type="button" onClick={() => setSfStep(1)} className="cm-btn-outline">← Back to orders</button>
                  <button type="button" onClick={() => setSfStep(1)} className="cm-btn-primary" style={{ width: "auto", padding: "8px 24px" }}>
                    Back to my orders →
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Days of Week Schedule Modal */}
      {isScheduleModalOpen && (
        <div className="cm-modal-overlay" onClick={() => setIsScheduleModalOpen(false)}>
          <div className="cm-modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "420px" }}>
            <div className="cm-modal-header">
              <h2 className="cm-modal-title">Active Days of Week</h2>
              <button type="button" className="cm-modal-close" onClick={() => setIsScheduleModalOpen(false)}>✕</button>
            </div>
            <div className="cm-modal-body">
              <p style={{ fontSize: "12.5px", color: "#5c5f62", margin: "0 0 12px 0" }}>
                Select which days customers can perform self-service edits:
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", fontSize: "13px" }}>
                {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => (
                  <label key={day} style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                    <input type="checkbox" defaultChecked style={{ accentColor: "#008060" }} />
                    <span>{day}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="cm-modal-footer">
              <button type="button" className="cm-btn-primary" style={{ width: "auto", padding: "6px 16px" }} onClick={() => setIsScheduleModalOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

