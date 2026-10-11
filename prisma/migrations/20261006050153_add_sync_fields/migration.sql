-- AlterEnum
ALTER TYPE "WebhookStatus" ADD VALUE 'IGNORED';

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "courierSyncAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastSyncError" TEXT,
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "shipments_courierTrackingNumber_status_idx" ON "shipments"("courierTrackingNumber", "status");

-- CreateIndex
CREATE INDEX "shipments_lastSyncedAt_idx" ON "shipments"("lastSyncedAt");

-- CreateIndex
CREATE INDEX "shipments_senderId_status_idx" ON "shipments"("senderId", "status");

-- CreateIndex
CREATE INDEX "shipments_recipientId_status_idx" ON "shipments"("recipientId", "status");
