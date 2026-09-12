-- AlterTable
ALTER TABLE "Chunk" ADD COLUMN     "reference_doc_id" TEXT,
ALTER COLUMN "meeting_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ReferenceDoc" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL DEFAULT '',
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "storage_key" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferenceDoc_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferenceDoc_project_id_status_idx" ON "ReferenceDoc"("project_id", "status");

-- CreateIndex
CREATE INDEX "ReferenceDoc_user_id_idx" ON "ReferenceDoc"("user_id");

-- CreateIndex
CREATE INDEX "Chunk_meeting_id_idx" ON "Chunk"("meeting_id");

-- CreateIndex
CREATE INDEX "Chunk_reference_doc_id_idx" ON "Chunk"("reference_doc_id");

-- CreateIndex
CREATE INDEX "Chunk_project_id_chunk_type_idx" ON "Chunk"("project_id", "chunk_type");

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_reference_doc_id_fkey" FOREIGN KEY ("reference_doc_id") REFERENCES "ReferenceDoc"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferenceDoc" ADD CONSTRAINT "ReferenceDoc_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
