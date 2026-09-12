-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";
-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";
-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference_files" TEXT NOT NULL DEFAULT '',
    "document" TEXT NOT NULL DEFAULT '',
    "no_document" BOOLEAN NOT NULL DEFAULT false,
    "index_dirty" BOOLEAN NOT NULL DEFAULT false,
    "index_dirty_at" TIMESTAMP(3),
    "index_built_at" TIMESTAMP(3),
    "index_json" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transcript" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "processing_status" TEXT NOT NULL DEFAULT 'pending',
    "document_diff" TEXT,
    "diff_status" TEXT,
    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ChunkParent" (
    "id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "project_id" TEXT,
    "meeting_date" TEXT,
    "content" TEXT NOT NULL,
    "speakers" TEXT NOT NULL,
    "line_start" INTEGER,
    "line_end" INTEGER,
    CONSTRAINT "ChunkParent_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "Chunk" (
    "id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "project_id" TEXT,
    "chunk_type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "section_title" TEXT,
    "speaker" TEXT,
    "line_start" INTEGER,
    "line_end" INTEGER,
    "meeting_date" TEXT,
    "search_text" TEXT,
    "embedding" vector(1024),
    "parent_id" TEXT,
    CONSTRAINT "Chunk_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ProcessingLog" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "meeting_id" TEXT,
    "context" TEXT NOT NULL,
    CONSTRAINT "ProcessingLog_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "run_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "last_error" TEXT,
    "tokens_used" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "UserSettings" (
    "user_id" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "lang" TEXT NOT NULL DEFAULT 'zh',
    "dreaming_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("user_id")
);
-- CreateIndex
CREATE INDEX "Project_user_id_idx" ON "Project"("user_id");
-- CreateIndex
CREATE INDEX "Project_index_dirty_idx" ON "Project"("index_dirty");
-- CreateIndex
CREATE INDEX "Meeting_user_id_idx" ON "Meeting"("user_id");
-- CreateIndex
CREATE INDEX "Meeting_project_id_diff_status_idx" ON "Meeting"("project_id", "diff_status");
-- CreateIndex
CREATE INDEX "ChunkParent_meeting_id_idx" ON "ChunkParent"("meeting_id");
-- CreateIndex
CREATE INDEX "ChunkParent_project_id_idx" ON "ChunkParent"("project_id");
-- CreateIndex
CREATE INDEX "Notification_user_id_created_at_idx" ON "Notification"("user_id", "created_at");
-- CreateIndex
CREATE INDEX "Job_status_run_after_idx" ON "Job"("status", "run_after");
-- CreateIndex
CREATE INDEX "Job_project_id_type_idx" ON "Job"("project_id", "type");
-- CreateIndex
CREATE INDEX "Job_user_id_idx" ON "Job"("user_id");
-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "Meeting"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
