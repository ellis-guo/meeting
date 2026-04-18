-- AlterTable
ALTER TABLE "Meeting" ALTER COLUMN "summary" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "ProcessingLog" ALTER COLUMN "context" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "Project" ALTER COLUMN "reference_files" SET DEFAULT '',
ALTER COLUMN "reference_files" SET DATA TYPE TEXT,
ALTER COLUMN "document" SET DEFAULT '',
ALTER COLUMN "document" SET DATA TYPE TEXT;
