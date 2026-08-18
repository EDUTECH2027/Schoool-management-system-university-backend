/*
  Warnings:

  - You are about to drop the `report_card_entries` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `report_cards` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "TranscriptStatus" AS ENUM ('draft', 'finalized', 'published', 'printed');

-- DropForeignKey
ALTER TABLE "report_card_entries" DROP CONSTRAINT "report_card_entries_report_card_id_fkey";

-- DropForeignKey
ALTER TABLE "report_card_entries" DROP CONSTRAINT "report_card_entries_subject_id_fkey";

-- DropForeignKey
ALTER TABLE "report_cards" DROP CONSTRAINT "report_cards_student_id_fkey";

-- DropForeignKey
ALTER TABLE "report_cards" DROP CONSTRAINT "report_cards_term_id_fkey";

-- AlterTable
ALTER TABLE "subjects" ADD COLUMN     "credit_hours" DOUBLE PRECISION NOT NULL DEFAULT 3;

-- DropTable
DROP TABLE "report_card_entries";

-- DropTable
DROP TABLE "report_cards";

-- DropEnum
DROP TYPE "ReportCardStatus";

-- CreateTable
CREATE TABLE "transcripts" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "student_name" TEXT,
    "student_number" TEXT,
    "class_name" TEXT,
    "grade_level_name" TEXT,
    "cumulative_gpa" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_credit_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_quality_points" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "terms_included" INTEGER NOT NULL DEFAULT 0,
    "status" "TranscriptStatus" NOT NULL DEFAULT 'draft',
    "generated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_entries" (
    "id" TEXT NOT NULL,
    "transcript_id" TEXT NOT NULL,
    "term_id" TEXT NOT NULL,
    "term_name" TEXT,
    "academic_year" TEXT,
    "subject_id" TEXT NOT NULL,
    "subject_name" TEXT,
    "ca_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "exam_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "credit_hours" DOUBLE PRECISION NOT NULL DEFAULT 3,
    "grade" TEXT,
    "grade_points" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "remark" TEXT,

    CONSTRAINT "transcript_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_student_id_key" ON "transcripts"("student_id");

-- CreateIndex
CREATE INDEX "transcript_entries_transcript_id_idx" ON "transcript_entries"("transcript_id");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_entries_transcript_id_subject_id_term_id_key" ON "transcript_entries"("transcript_id", "subject_id", "term_id");

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_entries" ADD CONSTRAINT "transcript_entries_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_entries" ADD CONSTRAINT "transcript_entries_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_entries" ADD CONSTRAINT "transcript_entries_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
