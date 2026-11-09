-- Dynamic taxonomy: provenance on Niche, video-level evidence, run audit. Additive only.
CREATE TYPE "NicheOrigin" AS ENUM ('SEED', 'DYNAMIC', 'MANUAL');
CREATE TYPE "NicheStatus" AS ENUM ('ACTIVE', 'PROVISIONAL', 'RETIRED');

ALTER TABLE "Niche"
  ADD COLUMN "videoCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "origin" "NicheOrigin" NOT NULL DEFAULT 'SEED',
  ADD COLUMN "status" "NicheStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "createdByRunId" TEXT,
  ADD COLUMN "bootstrap" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "Niche_origin_status_idx" ON "Niche"("origin", "status");

CREATE TABLE "VideoNiche" (
  "videoId" TEXT NOT NULL,
  "nicheId" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "decision" TEXT NOT NULL,
  "rationale" TEXT,
  "evidence" JSONB,
  "contentHash" TEXT,
  "model" TEXT,
  "promptVersion" TEXT,
  "taxonomyVersion" INTEGER NOT NULL DEFAULT 1,
  "runId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VideoNiche_pkey" PRIMARY KEY ("videoId", "nicheId")
);
CREATE INDEX "VideoNiche_nicheId_confidence_idx" ON "VideoNiche"("nicheId", "confidence");
ALTER TABLE "VideoNiche" ADD CONSTRAINT "VideoNiche_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VideoNiche" ADD CONSTRAINT "VideoNiche_nicheId_fkey" FOREIGN KEY ("nicheId") REFERENCES "Niche"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TaxonomyRun" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "params" JSONB NOT NULL DEFAULT '{}',
  "stats" JSONB NOT NULL DEFAULT '{}',
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "TaxonomyRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TaxonomyRun_startedAt_idx" ON "TaxonomyRun"("startedAt");
