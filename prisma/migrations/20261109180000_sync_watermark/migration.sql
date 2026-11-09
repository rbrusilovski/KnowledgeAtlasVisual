-- Sync reconciliation watermark (see UploadHistory.syncWatermark). Existing histories were collected newest-first
-- without gaps (initial windows / completed scans), so their newest collected upload is a safe starting watermark.
ALTER TABLE "UploadHistory" ADD COLUMN "syncWatermark" TIMESTAMP(3);
UPDATE "UploadHistory" SET "syncWatermark" = "newestPublishedAt";
