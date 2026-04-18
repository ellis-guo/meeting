/*
  Warnings:

  - Added the required column `chunk_type` to the `Chunk` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Chunk" ADD COLUMN     "chunk_type" TEXT NOT NULL,
ADD COLUMN     "line_end" INTEGER,
ADD COLUMN     "line_start" INTEGER,
ADD COLUMN     "speaker" TEXT;

-- CreateTable
CREATE TABLE "ProcessingLog" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "meeting_id" TEXT,
    "context" JSONB NOT NULL,

    CONSTRAINT "ProcessingLog_pkey" PRIMARY KEY ("id")
);
