-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "EditSessionStatus" AS ENUM ('ACTIVE', 'IN_PROGRESS', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED', 'PAYMENT_REQUIRED');

-- CreateEnum
CREATE TYPE "ChangeType" AS ENUM ('ADD_PRODUCT', 'REMOVE_PRODUCT', 'CHANGE_QUANTITY', 'CHANGE_VARIANT', 'CHANGE_ADDRESS');

-- CreateEnum
CREATE TYPE "EditEventType" AS ENUM ('SESSION_CREATED', 'SESSION_OPENED', 'EDIT_STARTED', 'ITEM_ADDED', 'ITEM_REMOVED', 'QUANTITY_CHANGED', 'VARIANT_CHANGED', 'ADDRESS_CHANGED', 'EDIT_VALIDATED', 'SHOPIFY_EDIT_STARTED', 'SHOPIFY_EDIT_COMMITTED', 'PAYMENT_REQUIRED', 'PAYMENT_COMPLETED', 'EDIT_COMPLETED', 'EDIT_FAILED', 'SESSION_EXPIRED', 'SESSION_CANCELLED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('CUSTOMER', 'MERCHANT', 'SYSTEM', 'SHOPIFY');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('EDIT_LINK', 'EDIT_CONFIRMATION', 'EDIT_EXPIRED', 'PAYMENT_REQUIRED', 'EDIT_FAILED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopifyShopId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT,
    "scopes" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "editingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "editingWindowMinutes" INTEGER NOT NULL DEFAULT 30,
    "allowQuantityChange" BOOLEAN NOT NULL DEFAULT true,
    "allowVariantChange" BOOLEAN NOT NULL DEFAULT true,
    "allowAddProduct" BOOLEAN NOT NULL DEFAULT false,
    "allowRemoveProduct" BOOLEAN NOT NULL DEFAULT true,
    "allowAddressChange" BOOLEAN NOT NULL DEFAULT false,
    "requirePaymentForDifference" BOOLEAN NOT NULL DEFAULT true,
    "allowRefundForDifference" BOOLEAN NOT NULL DEFAULT true,
    "notifyCustomer" BOOLEAN NOT NULL DEFAULT true,
    "sendEditLinkEmail" BOOLEAN NOT NULL DEFAULT true,
    "supportEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderGid" TEXT NOT NULL,
    "shopifyOrderName" TEXT NOT NULL,
    "customerShopifyId" TEXT,
    "customerEmail" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "originalTotal" DOUBLE PRECISION NOT NULL,
    "currentTotal" DOUBLE PRECISION NOT NULL,
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "orderCreatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderEditSession" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "EditSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "originalTotal" DOUBLE PRECISION NOT NULL,
    "finalTotal" DOUBLE PRECISION,
    "shopifyOrderEditSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderEditSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderEditChange" (
    "id" TEXT NOT NULL,
    "editSessionId" TEXT NOT NULL,
    "changeType" "ChangeType" NOT NULL,
    "shopifyLineItemId" TEXT,
    "shopifyProductId" TEXT,
    "shopifyVariantId" TEXT,
    "oldVariantId" TEXT,
    "newVariantId" TEXT,
    "oldQuantity" INTEGER,
    "newQuantity" INTEGER,
    "oldPrice" DOUBLE PRECISION,
    "newPrice" DOUBLE PRECISION,
    "quantityDelta" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEditChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderEditEvent" (
    "id" TEXT NOT NULL,
    "editSessionId" TEXT NOT NULL,
    "eventType" "EditEventType" NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyWebhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT,
    "editSessionId" TEXT,
    "type" "NotificationType" NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "isActivated" BOOLEAN NOT NULL DEFAULT false,
    "editWindowHours" INTEGER NOT NULL DEFAULT 24,
    "allowAddressEdit" BOOLEAN NOT NULL DEFAULT true,
    "allowQuantityChange" BOOLEAN NOT NULL DEFAULT true,
    "allowItemSwap" BOOLEAN NOT NULL DEFAULT true,
    "allowOrderCancellation" BOOLEAN NOT NULL DEFAULT true,
    "requireCustomerAccount" BOOLEAN NOT NULL DEFAULT false,
    "notifyMerchantOnEdit" BOOLEAN NOT NULL DEFAULT true,
    "supportEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderActivity" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "actionType" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "details" TEXT,
    "previousTotal" DOUBLE PRECISION,
    "newTotal" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopifyShopId_key" ON "Shop"("shopifyShopId");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Shop_shopDomain_idx" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Shop_shopifyShopId_idx" ON "Shop"("shopifyShopId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shopId_key" ON "ShopSettings"("shopId");

-- CreateIndex
CREATE INDEX "ShopSettings_shopId_idx" ON "ShopSettings"("shopId");

-- CreateIndex
CREATE INDEX "Order_shopId_idx" ON "Order"("shopId");

-- CreateIndex
CREATE INDEX "Order_shopifyOrderId_idx" ON "Order"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "Order_customerShopifyId_idx" ON "Order"("customerShopifyId");

-- CreateIndex
CREATE INDEX "Order_orderCreatedAt_idx" ON "Order"("orderCreatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shopId_shopifyOrderId_key" ON "Order"("shopId", "shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderEditSession_tokenHash_key" ON "OrderEditSession"("tokenHash");

-- CreateIndex
CREATE INDEX "OrderEditSession_tokenHash_idx" ON "OrderEditSession"("tokenHash");

-- CreateIndex
CREATE INDEX "OrderEditSession_shopId_idx" ON "OrderEditSession"("shopId");

-- CreateIndex
CREATE INDEX "OrderEditSession_orderId_idx" ON "OrderEditSession"("orderId");

-- CreateIndex
CREATE INDEX "OrderEditSession_status_idx" ON "OrderEditSession"("status");

-- CreateIndex
CREATE INDEX "OrderEditSession_expiresAt_idx" ON "OrderEditSession"("expiresAt");

-- CreateIndex
CREATE INDEX "OrderEditChange_editSessionId_idx" ON "OrderEditChange"("editSessionId");

-- CreateIndex
CREATE INDEX "OrderEditEvent_editSessionId_idx" ON "OrderEditEvent"("editSessionId");

-- CreateIndex
CREATE INDEX "OrderEditEvent_eventType_idx" ON "OrderEditEvent"("eventType");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopId_idx" ON "WebhookEvent"("shopId");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopifyWebhookId_idx" ON "WebhookEvent"("shopifyWebhookId");

-- CreateIndex
CREATE INDEX "WebhookEvent_topic_idx" ON "WebhookEvent"("topic");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_shopId_shopifyWebhookId_key" ON "WebhookEvent"("shopId", "shopifyWebhookId");

-- CreateIndex
CREATE INDEX "Notification_shopId_idx" ON "Notification"("shopId");

-- CreateIndex
CREATE INDEX "Notification_orderId_idx" ON "Notification"("orderId");

-- CreateIndex
CREATE INDEX "Notification_editSessionId_idx" ON "Notification"("editSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "AppSettings_shop_key" ON "AppSettings"("shop");

-- AddForeignKey
ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEditSession" ADD CONSTRAINT "OrderEditSession_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEditSession" ADD CONSTRAINT "OrderEditSession_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEditChange" ADD CONSTRAINT "OrderEditChange_editSessionId_fkey" FOREIGN KEY ("editSessionId") REFERENCES "OrderEditSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEditEvent" ADD CONSTRAINT "OrderEditEvent_editSessionId_fkey" FOREIGN KEY ("editSessionId") REFERENCES "OrderEditSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_editSessionId_fkey" FOREIGN KEY ("editSessionId") REFERENCES "OrderEditSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

