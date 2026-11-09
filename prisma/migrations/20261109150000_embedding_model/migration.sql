-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "embeddingModel" TEXT;

-- AlterTable
ALTER TABLE "Niche" ADD COLUMN     "embeddingModel" TEXT;

-- AlterTable
ALTER TABLE "Topic" ADD COLUMN     "embeddingModel" TEXT;

-- AlterTable
ALTER TABLE "TranscriptChunk" ADD COLUMN     "embeddingModel" TEXT;

-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "embeddingModel" TEXT;
