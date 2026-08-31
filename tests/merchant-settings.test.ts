import { describe, it, expect, beforeEach } from "vitest";
import {
  getOrCreateShop,
  getMerchantSettings,
  updateMerchantSettings,
} from "../app/services/merchant-settings.server";
import { InvalidEditRequest } from "../app/services/errors";
import prisma from "../app/db.server";

describe("Merchant Settings Service", () => {
  const testId = Date.now();
  const shopDomainA = `test-store-a-${testId}.myshopify.com`;
  const shopDomainB = `test-store-b-${testId}.myshopify.com`;

  it("should create shop with default settings if not exists", async () => {
    const shop = await getOrCreateShop(shopDomainA);
    expect(shop).toBeDefined();
    expect(shop.shopDomain).toBe(shopDomainA);

    const settings = await getMerchantSettings(shopDomainA);
    expect(settings).toBeDefined();
    expect(settings.editingEnabled).toBe(false);
    expect(settings.editingWindowMinutes).toBe(180);
    expect(settings.allowQuantityChange).toBe(true);
    expect(settings.allowVariantChange).toBe(true);
    expect(settings.allowAddProduct).toBe(false);
    expect(settings.allowRemoveProduct).toBe(true);
    expect(settings.allowAddressChange).toBe(true);
    expect(settings.requirePaymentForDifference).toBe(true);
    expect(settings.allowRefundForDifference).toBe(true);
    expect(settings.notifyCustomer).toBe(true);
    expect(settings.sendEditLinkEmail).toBe(true);
  });

  it("should update merchant settings and enforce validation", async () => {
    const updated = await updateMerchantSettings(shopDomainA, {
      editingEnabled: true,
      editingWindowMinutes: 60,
      allowAddProduct: true,
      allowAddressChange: true,
      supportEmail: "custom-support@store-a.com",
    });

    expect(updated.editingEnabled).toBe(true);
    expect(updated.editingWindowMinutes).toBe(60);
    expect(updated.allowAddProduct).toBe(true);
    expect(updated.allowAddressChange).toBe(true);
    expect(updated.supportEmail).toBe("custom-support@store-a.com");
  });

  it("should reject invalid editing window values", async () => {
    await expect(
      updateMerchantSettings(shopDomainA, { editingWindowMinutes: -5 })
    ).rejects.toThrow(InvalidEditRequest);

    await expect(
      updateMerchantSettings(shopDomainA, { editingWindowMinutes: 0 })
    ).rejects.toThrow(InvalidEditRequest);

    await expect(
      updateMerchantSettings(shopDomainA, { editingWindowMinutes: 50000 })
    ).rejects.toThrow(InvalidEditRequest);
  });

  it("should maintain multi-tenant isolation between different shops", async () => {
    await getOrCreateShop(shopDomainA);
    await getOrCreateShop(shopDomainB);

    await updateMerchantSettings(shopDomainA, { editingEnabled: true, editingWindowMinutes: 120 });
    await updateMerchantSettings(shopDomainB, { editingEnabled: false, editingWindowMinutes: 45 });

    const settingsA = await getMerchantSettings(shopDomainA);
    const settingsB = await getMerchantSettings(shopDomainB);

    expect(settingsA.editingEnabled).toBe(true);
    expect(settingsA.editingWindowMinutes).toBe(120);

    expect(settingsB.editingEnabled).toBe(false);
    expect(settingsB.editingWindowMinutes).toBe(45);
  });

  it("should update email notification toggles and appearance theme", async () => {
    const updated = await updateMerchantSettings(shopDomainA, {
      sendEditLinkEmail: false,
      notifyCustomer: false,
      sendPaymentRefundEmails: false,
      theme: "Dark",
    });

    expect(updated.sendEditLinkEmail).toBe(false);
    expect(updated.notifyCustomer).toBe(false);
    expect((updated as any).sendPaymentRefundEmails).toBe(false);
    expect((updated as any).theme).toBe("Dark");
  });

  it("should create and track merchant support tickets and send notification to hello@explified.com", async () => {
    const { createSupportTicket } = await import("../app/services/merchant-settings.server");
    const { EXPLIFIED_SUPPORT_EMAIL } = await import("../app/services/notification.server");

    expect(EXPLIFIED_SUPPORT_EMAIL).toBe("hello@explified.com");

    const ticket = await createSupportTicket({
      shopDomain: shopDomainA,
      shopName: "Store A Flagship",
      issueType: "Order Editing Issue",
      orderId: "#10482",
      description: "Customer wants to edit quantity but button is disabled",
      email: "merchant@store-a.com",
      attachment: "screenshot.png",
    });

    expect(ticket).toBeDefined();
    expect(ticket.ticketNumber).toMatch(/^TKT-\d+/);
    expect(ticket.issueType).toBe("Order Editing Issue");
    expect(ticket.orderId).toBe("#10482");
    expect(ticket.description).toBe("Customer wants to edit quantity but button is disabled");
    expect(ticket.email).toBe("merchant@store-a.com");
    expect(ticket.attachment).toBe("screenshot.png");
    expect(ticket.status).toBe("OPEN");
    expect(ticket.createdAt).toBeDefined();

    // Verify internal tracking in DB
    const savedTicket = await prisma.supportTicket.findUnique({
      where: { ticketNumber: ticket.ticketNumber },
    });
    expect(savedTicket).toBeDefined();
    expect(savedTicket?.shopDomain).toBe(shopDomainA);
    expect(savedTicket?.status).toBe("OPEN");

    // Verify notification record in Notification log for hello@explified.com
    const notification = await prisma.notification.findFirst({
      where: {
        recipient: "hello@explified.com",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(notification).toBeDefined();
    expect(notification?.recipient).toBe("hello@explified.com");
    expect(notification?.status).toBe("DELIVERED");
  });
});
