-- Data origin. Live collection had never been enabled before this migration, so every existing channel came from the
-- fictional fixture dataset.
CREATE TYPE "DataOrigin" AS ENUM ('YOUTUBE', 'FIXTURE');
ALTER TABLE "Channel" ADD COLUMN "dataOrigin" "DataOrigin" NOT NULL DEFAULT 'YOUTUBE';
UPDATE "Channel" SET "dataOrigin" = 'FIXTURE';
CREATE INDEX "Channel_dataOrigin_idx" ON "Channel"("dataOrigin");
