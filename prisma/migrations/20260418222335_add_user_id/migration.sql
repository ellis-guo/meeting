/*
  Warnings:

  - Added the required column `user_id` to the `Meeting` table without a default value. This is not possible if the table is not empty.
  - Added the required column `user_id` to the `Project` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN     "user_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "user_id" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Meeting_user_id_idx" ON "Meeting"("user_id");

-- CreateIndex
CREATE INDEX "Project_user_id_idx" ON "Project"("user_id");
