-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('registered', 'pending_approval', 'rejected', 'dropped');

-- CreateEnum
CREATE TYPE "MarkStatus" AS ENUM ('draft', 'submitted', 'approved', 'published');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'academic_officer';

-- AlterTable
ALTER TABLE "subjects" ADD COLUMN     "department_id" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "level_id" TEXT,
ADD COLUMN     "semester" "TermName";

-- AlterTable
ALTER TABLE "classes" ADD COLUMN     "programme_id" TEXT;

-- AlterTable
ALTER TABLE "students" ADD COLUMN     "academic_status" TEXT NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "marks" ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by" TEXT,
ADD COLUMN     "entered_by" TEXT,
ADD COLUMN     "exam_absent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "offering_id" TEXT,
ADD COLUMN     "published_at" TIMESTAMP(3),
ADD COLUMN     "published_by" TEXT,
ADD COLUMN     "status" "MarkStatus" NOT NULL DEFAULT 'draft',
ADD COLUMN     "submitted_at" TIMESTAMP(3),
ADD COLUMN     "submitted_by" TEXT;

-- CreateTable
CREATE TABLE "faculties" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faculties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "faculty_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "head_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programmes" (
    "id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "award" TEXT,
    "duration_years" INTEGER NOT NULL DEFAULT 3,
    "credits_required" DOUBLE PRECISION,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "programmes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_prerequisites" (
    "subject_id" TEXT NOT NULL,
    "prerequisite_id" TEXT NOT NULL,

    CONSTRAINT "course_prerequisites_pkey" PRIMARY KEY ("subject_id","prerequisite_id")
);

-- CreateTable
CREATE TABLE "programme_courses" (
    "id" TEXT NOT NULL,
    "programme_id" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "level_id" TEXT,
    "semester" "TermName" NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'core',

    CONSTRAINT "programme_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_offerings" (
    "id" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "term_id" TEXT NOT NULL,
    "teacher_id" TEXT,
    "section" TEXT NOT NULL DEFAULT 'A',
    "capacity" INTEGER,
    "is_open" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "course_offerings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offering_slots" (
    "id" TEXT NOT NULL,
    "offering_id" TEXT NOT NULL,
    "day" "Day" NOT NULL,
    "period_key" TEXT NOT NULL,
    "room" TEXT,

    CONSTRAINT "offering_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_periods" (
    "id" TEXT NOT NULL,
    "term_id" TEXT NOT NULL,
    "programme_id" TEXT,
    "level_id" TEXT,
    "name" TEXT,
    "opens_at" TIMESTAMP(3) NOT NULL,
    "closes_at" TIMESTAMP(3) NOT NULL,
    "add_drop_until" TIMESTAMP(3),
    "min_credits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "max_credits" DOUBLE PRECISION NOT NULL DEFAULT 30,
    "allow_exceptions" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registration_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_enrollments" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "offering_id" TEXT NOT NULL,
    "term_id" TEXT NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'registered',
    "credits" DOUBLE PRECISION NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'regular',
    "exception_reason" TEXT,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dropped_at" TIMESTAMP(3),
    "decision_by" TEXT,
    "decision_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_by" TEXT,

    CONSTRAINT "course_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grading_schemes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "ca_weight" DOUBLE PRECISION NOT NULL DEFAULT 40,
    "exam_weight" DOUBLE PRECISION NOT NULL DEFAULT 60,
    "pass_mark" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "resit_cap" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grading_schemes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_bands" (
    "id" TEXT NOT NULL,
    "scheme_id" TEXT NOT NULL,
    "min_score" DOUBLE PRECISION NOT NULL,
    "grade" TEXT NOT NULL,
    "points" DOUBLE PRECISION NOT NULL,
    "remark" TEXT,
    "is_pass" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "grade_bands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mark_history" (
    "id" TEXT NOT NULL,
    "mark_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "actor_id" TEXT,
    "actor_name" TEXT,
    "actor_role" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mark_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_sessions" (
    "id" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "term_id" TEXT NOT NULL,
    "offering_id" TEXT,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'final',
    "date" TEXT NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "room" TEXT,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_invigilators" (
    "exam_id" TEXT NOT NULL,
    "teacher_id" TEXT NOT NULL,

    CONSTRAINT "exam_invigilators_pkey" PRIMARY KEY ("exam_id","teacher_id")
);

-- CreateTable
CREATE TABLE "exam_candidates" (
    "id" TEXT NOT NULL,
    "exam_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "eligible" BOOLEAN NOT NULL DEFAULT true,
    "ineligible_reasons" JSONB,
    "attendance" TEXT,
    "override_by" TEXT,
    "override_reason" TEXT,
    "recorded_by" TEXT,
    "recorded_at" TIMESTAMP(3),

    CONSTRAINT "exam_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_appeals" (
    "id" TEXT NOT NULL,
    "mark_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "reviewed_by" TEXT,
    "decision_note" TEXT,
    "new_ca" DOUBLE PRECISION,
    "new_exam" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "grade_appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_settings" (
    "id" TEXT NOT NULL DEFAULT 'main',
    "exam_min_attendance_pct" DOUBLE PRECISION,
    "exam_fee_rule" TEXT NOT NULL DEFAULT 'none',
    "exam_min_paid_pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "progression" JSONB,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academic_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progression_decisions" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "academic_year_id" TEXT NOT NULL,
    "programme_id" TEXT,
    "level_id" TEXT,
    "outcome" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "target_class_id" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progression_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_enrollment_history" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "academic_year_id" TEXT,
    "class_id" TEXT,
    "class_name" TEXT,
    "programme_id" TEXT,
    "programme_name" TEXT,
    "level_name" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "reason" TEXT,

    CONSTRAINT "student_enrollment_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "official_documents" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "academic_year_id" TEXT,
    "term_id" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "issued_by" TEXT,
    "issued_by_name" TEXT,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,

    CONSTRAINT "official_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "faculties_name_key" ON "faculties"("name");

-- CreateIndex
CREATE UNIQUE INDEX "faculties_code_key" ON "faculties"("code");

-- CreateIndex
CREATE UNIQUE INDEX "departments_faculty_id_code_key" ON "departments"("faculty_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "departments_faculty_id_name_key" ON "departments"("faculty_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "programmes_code_key" ON "programmes"("code");

-- CreateIndex
CREATE INDEX "programmes_department_id_idx" ON "programmes"("department_id");

-- CreateIndex
CREATE INDEX "programme_courses_subject_id_idx" ON "programme_courses"("subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "programme_courses_programme_id_subject_id_key" ON "programme_courses"("programme_id", "subject_id");

-- CreateIndex
CREATE INDEX "course_offerings_term_id_idx" ON "course_offerings"("term_id");

-- CreateIndex
CREATE INDEX "course_offerings_teacher_id_idx" ON "course_offerings"("teacher_id");

-- CreateIndex
CREATE UNIQUE INDEX "course_offerings_subject_id_term_id_section_key" ON "course_offerings"("subject_id", "term_id", "section");

-- CreateIndex
CREATE UNIQUE INDEX "offering_slots_offering_id_day_period_key_key" ON "offering_slots"("offering_id", "day", "period_key");

-- CreateIndex
CREATE INDEX "registration_periods_term_id_opens_at_idx" ON "registration_periods"("term_id", "opens_at");

-- CreateIndex
CREATE INDEX "course_enrollments_student_id_term_id_idx" ON "course_enrollments"("student_id", "term_id");

-- CreateIndex
CREATE INDEX "course_enrollments_offering_id_status_idx" ON "course_enrollments"("offering_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "course_enrollments_student_id_offering_id_key" ON "course_enrollments"("student_id", "offering_id");

-- CreateIndex
CREATE UNIQUE INDEX "grade_bands_scheme_id_grade_key" ON "grade_bands"("scheme_id", "grade");

-- CreateIndex
CREATE INDEX "mark_history_mark_id_created_at_idx" ON "mark_history"("mark_id", "created_at");

-- CreateIndex
CREATE INDEX "exam_sessions_term_id_date_idx" ON "exam_sessions"("term_id", "date");

-- CreateIndex
CREATE INDEX "exam_candidates_student_id_idx" ON "exam_candidates"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_candidates_exam_id_student_id_key" ON "exam_candidates"("exam_id", "student_id");

-- CreateIndex
CREATE INDEX "grade_appeals_student_id_idx" ON "grade_appeals"("student_id");

-- CreateIndex
CREATE INDEX "grade_appeals_status_idx" ON "grade_appeals"("status");

-- CreateIndex
CREATE INDEX "progression_decisions_academic_year_id_status_idx" ON "progression_decisions"("academic_year_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "progression_decisions_student_id_academic_year_id_key" ON "progression_decisions"("student_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "student_enrollment_history_student_id_started_at_idx" ON "student_enrollment_history"("student_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "official_documents_code_key" ON "official_documents"("code");

-- CreateIndex
CREATE INDEX "official_documents_student_id_type_idx" ON "official_documents"("student_id", "type");

-- CreateIndex
CREATE INDEX "subjects_department_id_idx" ON "subjects"("department_id");

-- CreateIndex
CREATE INDEX "classes_programme_id_idx" ON "classes"("programme_id");

-- CreateIndex
CREATE INDEX "marks_status_idx" ON "marks"("status");

-- CreateIndex
CREATE INDEX "marks_subject_id_term_id_idx" ON "marks"("subject_id", "term_id");

-- AddForeignKey
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "grade_levels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_faculty_id_fkey" FOREIGN KEY ("faculty_id") REFERENCES "faculties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programmes" ADD CONSTRAINT "programmes_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_prerequisites" ADD CONSTRAINT "course_prerequisites_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_prerequisites" ADD CONSTRAINT "course_prerequisites_prerequisite_id_fkey" FOREIGN KEY ("prerequisite_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programme_courses" ADD CONSTRAINT "programme_courses_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programme_courses" ADD CONSTRAINT "programme_courses_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offerings" ADD CONSTRAINT "course_offerings_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offerings" ADD CONSTRAINT "course_offerings_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offerings" ADD CONSTRAINT "course_offerings_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_slots" ADD CONSTRAINT "offering_slots_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "course_offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_periods" ADD CONSTRAINT "registration_periods_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_periods" ADD CONSTRAINT "registration_periods_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "course_offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_bands" ADD CONSTRAINT "grade_bands_scheme_id_fkey" FOREIGN KEY ("scheme_id") REFERENCES "grading_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mark_history" ADD CONSTRAINT "mark_history_mark_id_fkey" FOREIGN KEY ("mark_id") REFERENCES "marks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "course_offerings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_invigilators" ADD CONSTRAINT "exam_invigilators_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exam_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_invigilators" ADD CONSTRAINT "exam_invigilators_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_candidates" ADD CONSTRAINT "exam_candidates_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exam_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_candidates" ADD CONSTRAINT "exam_candidates_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_appeals" ADD CONSTRAINT "grade_appeals_mark_id_fkey" FOREIGN KEY ("mark_id") REFERENCES "marks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_appeals" ADD CONSTRAINT "grade_appeals_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progression_decisions" ADD CONSTRAINT "progression_decisions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_enrollment_history" ADD CONSTRAINT "student_enrollment_history_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "official_documents" ADD CONSTRAINT "official_documents_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══ Backfill: keep every existing record behaving exactly as before ═══════════════════

-- 1. Marks that already existed were visible to students → keep them published.
UPDATE "marks" SET "status" = 'published', "published_at" = COALESCE("updated_at", CURRENT_TIMESTAMP);

-- 2. Default grading scheme = the rules that used to be hardcoded (CA 40 % / exam 60 %, pass mark 50, A+…F, 4-point scale).
INSERT INTO "grading_schemes" ("id", "name", "is_active", "ca_weight", "exam_weight", "pass_mark")
VALUES ('scheme-default', 'Default (CA 40 / Exam 60)', true, 40, 60, 50);
INSERT INTO "grade_bands" ("id", "scheme_id", "min_score", "grade", "points", "remark", "is_pass") VALUES
  ('band-default-aplus', 'scheme-default', 90, 'A+', 4, 'Excellent',     true),
  ('band-default-a',     'scheme-default', 80, 'A',  4, 'Very Good',     true),
  ('band-default-b',     'scheme-default', 70, 'B',  3, 'Good',          true),
  ('band-default-c',     'scheme-default', 60, 'C',  2, 'Average',       true),
  ('band-default-d',     'scheme-default', 50, 'D',  1, 'Below Average', true),
  ('band-default-f',     'scheme-default',  0, 'F',  0, 'Fail',          false);

-- 3. Academic settings row (all rules start switched off / permissive).
INSERT INTO "academic_settings" ("id") VALUES ('main');

-- 4. Structure: a "General" faculty/department, and one Programme per existing Class (the Class becomes its cohort).
INSERT INTO "faculties" ("id", "name", "code") VALUES ('fac-general', 'General', 'GEN');
INSERT INTO "departments" ("id", "faculty_id", "name", "code") VALUES ('dep-general', 'fac-general', 'General', 'GEN');
INSERT INTO "programmes" ("id", "department_id", "name", "code", "duration_years")
  SELECT 'prg-' || "id", 'dep-general', "name", 'PRG-' || upper(substr(replace("id", '-', ''), 1, 8)), 3 FROM "classes";
UPDATE "classes" SET "programme_id" = 'prg-' || "id";

-- 5. Enrolment history starts with a snapshot of where every student currently is.
INSERT INTO "student_enrollment_history" ("id", "student_id", "class_id", "class_name", "programme_id", "programme_name", "level_name", "reason")
  SELECT 'seh-' || s."id", s."id", s."class_id", c."name", c."programme_id", c."name", g."name", 'Initial snapshot'
  FROM "students" s LEFT JOIN "classes" c ON c."id" = s."class_id" LEFT JOIN "grade_levels" g ON g."id" = c."grade_level_id";
