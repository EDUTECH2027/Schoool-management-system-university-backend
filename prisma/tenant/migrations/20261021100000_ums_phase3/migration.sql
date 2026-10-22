-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'librarian';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "failed_logins" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "locked_until" TIMESTAMP(3),
ADD COLUMN     "password_changed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "offering_slots" ADD COLUMN     "room_id" TEXT;

-- AlterTable
ALTER TABLE "exam_sessions" ADD COLUMN     "room_id" TEXT;

-- CreateTable
CREATE TABLE "assignments" (
    "id" TEXT NOT NULL,
    "offering_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "due_at" TIMESTAMP(3) NOT NULL,
    "max_score" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "allow_late" BOOLEAN NOT NULL DEFAULT false,
    "allow_text" BOOLEAN NOT NULL DEFAULT true,
    "allow_file" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_submissions" (
    "id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "text" TEXT,
    "file_name" TEXT,
    "file_mime" TEXT,
    "file_size" INTEGER,
    "file_data" BYTEA,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_late" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "score" DOUBLE PRECISION,
    "feedback" TEXT,
    "graded_by" TEXT,
    "graded_at" TIMESTAMP(3),

    CONSTRAINT "assignment_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quizzes" (
    "id" TEXT NOT NULL,
    "offering_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "opens_at" TIMESTAMP(3),
    "closes_at" TIMESTAMP(3),
    "duration_minutes" INTEGER,
    "max_attempts" INTEGER NOT NULL DEFAULT 1,
    "shuffle" BOOLEAN NOT NULL DEFAULT false,
    "show_answers" BOOLEAN NOT NULL DEFAULT false,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quizzes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_questions" (
    "id" TEXT NOT NULL,
    "quiz_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "options" JSONB,
    "answer" JSONB NOT NULL,
    "points" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "explanation" TEXT,

    CONSTRAINT "quiz_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_attempts" (
    "id" TEXT NOT NULL,
    "quiz_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "answers" JSONB,
    "score" DOUBLE PRECISION,
    "max_score" DOUBLE PRECISION,
    "question_order" JSONB,

    CONSTRAINT "quiz_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_requests" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "assigned_to" TEXT,
    "decision_note" TEXT,
    "document_id" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_request_events" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "body" TEXT,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "author_id" TEXT,
    "author_name" TEXT,
    "author_role" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_request_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "muted_types" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "to_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" JSONB NOT NULL,
    "channels" JSONB NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_items" (
    "id" TEXT NOT NULL,
    "isbn" TEXT,
    "title" TEXT NOT NULL,
    "authors" TEXT,
    "publisher" TEXT,
    "year" INTEGER,
    "category" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'book',
    "location" TEXT,
    "description" TEXT,
    "copies_total" INTEGER NOT NULL DEFAULT 1,
    "digital_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_loans" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "student_id" TEXT,
    "teacher_id" TEXT,
    "borrowed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMP(3) NOT NULL,
    "returned_at" TIMESTAMP(3),
    "renewals" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "fine_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fine_paid" BOOLEAN NOT NULL DEFAULT false,
    "fine_waived" BOOLEAN NOT NULL DEFAULT false,
    "issued_by" TEXT,

    CONSTRAINT "library_loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_reservations" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_at" TIMESTAMP(3),

    CONSTRAINT "library_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_settings" (
    "id" TEXT NOT NULL,
    "loan_days" INTEGER NOT NULL DEFAULT 14,
    "max_loans" INTEGER NOT NULL DEFAULT 3,
    "max_renewals" INTEGER NOT NULL DEFAULT 2,
    "fine_per_day" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "currency" TEXT NOT NULL DEFAULT 'XAF',
    "block_on_fines" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "building" TEXT,
    "capacity" INTEGER NOT NULL DEFAULT 30,
    "kind" TEXT NOT NULL DEFAULT 'classroom',
    "equipment" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_bookings" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "booked_by" TEXT,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_periods" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "timetable_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alumni_profiles" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "graduation_year" INTEGER,
    "programme_name" TEXT,
    "employer" TEXT,
    "position" TEXT,
    "city" TEXT,
    "bio" TEXT,
    "linkedin_url" TEXT,
    "contact_email" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alumni_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_postings" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'job',
    "location" TEXT,
    "description" TEXT NOT NULL,
    "apply_url" TEXT,
    "contact_email" TEXT,
    "deadline" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "posted_by" TEXT,
    "posted_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_applications" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "cover_note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "theses" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "abstract" TEXT,
    "keywords" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'thesis',
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "supervisor_id" TEXT,
    "co_supervisor_id" TEXT,
    "defence_date" TEXT,
    "defence_time" TEXT,
    "defence_room" TEXT,
    "jury" JSONB,
    "final_score" DOUBLE PRECISION,
    "final_grade" TEXT,
    "decision_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "theses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thesis_milestones" (
    "id" TEXT NOT NULL,
    "thesis_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "due_date" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "feedback" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thesis_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thesis_submissions" (
    "id" TEXT NOT NULL,
    "thesis_id" TEXT NOT NULL,
    "milestone_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "file_name" TEXT,
    "file_mime" TEXT,
    "file_size" INTEGER,
    "file_data" BYTEA,
    "feedback" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thesis_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thesis_events" (
    "id" TEXT NOT NULL,
    "thesis_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "body" TEXT,
    "author_id" TEXT,
    "author_name" TEXT,
    "author_role" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thesis_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_usage" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "tokens" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "assistant_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "email" TEXT,
    "type" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assignments_offering_id_status_idx" ON "assignments"("offering_id", "status");

-- CreateIndex
CREATE INDEX "assignment_submissions_student_id_idx" ON "assignment_submissions"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_submissions_assignment_id_student_id_key" ON "assignment_submissions"("assignment_id", "student_id");

-- CreateIndex
CREATE INDEX "quizzes_offering_id_status_idx" ON "quizzes"("offering_id", "status");

-- CreateIndex
CREATE INDEX "quiz_questions_quiz_id_position_idx" ON "quiz_questions"("quiz_id", "position");

-- CreateIndex
CREATE INDEX "quiz_attempts_student_id_idx" ON "quiz_attempts"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "quiz_attempts_quiz_id_student_id_attempt_no_key" ON "quiz_attempts"("quiz_id", "student_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "service_requests_reference_key" ON "service_requests"("reference");

-- CreateIndex
CREATE INDEX "service_requests_student_id_idx" ON "service_requests"("student_id");

-- CreateIndex
CREATE INDEX "service_requests_status_created_at_idx" ON "service_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "service_request_events_request_id_created_at_idx" ON "service_request_events"("request_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_user_id_key" ON "notification_preferences"("user_id");

-- CreateIndex
CREATE INDEX "email_outbox_status_created_at_idx" ON "email_outbox"("status", "created_at");

-- CreateIndex
CREATE INDEX "library_items_title_idx" ON "library_items"("title");

-- CreateIndex
CREATE INDEX "library_items_isbn_idx" ON "library_items"("isbn");

-- CreateIndex
CREATE INDEX "library_loans_item_id_status_idx" ON "library_loans"("item_id", "status");

-- CreateIndex
CREATE INDEX "library_loans_student_id_status_idx" ON "library_loans"("student_id", "status");

-- CreateIndex
CREATE INDEX "library_reservations_item_id_status_idx" ON "library_reservations"("item_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_code_key" ON "rooms"("code");

-- CreateIndex
CREATE INDEX "room_bookings_room_id_date_idx" ON "room_bookings"("room_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_periods_key_key" ON "timetable_periods"("key");

-- CreateIndex
CREATE UNIQUE INDEX "alumni_profiles_student_id_key" ON "alumni_profiles"("student_id");

-- CreateIndex
CREATE INDEX "job_postings_status_created_at_idx" ON "job_postings"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_applications_job_id_student_id_key" ON "job_applications"("job_id", "student_id");

-- CreateIndex
CREATE INDEX "theses_student_id_idx" ON "theses"("student_id");

-- CreateIndex
CREATE INDEX "theses_supervisor_id_idx" ON "theses"("supervisor_id");

-- CreateIndex
CREATE INDEX "thesis_milestones_thesis_id_idx" ON "thesis_milestones"("thesis_id");

-- CreateIndex
CREATE INDEX "thesis_submissions_thesis_id_idx" ON "thesis_submissions"("thesis_id");

-- CreateIndex
CREATE INDEX "thesis_events_thesis_id_created_at_idx" ON "thesis_events"("thesis_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_usage_user_id_day_key" ON "assistant_usage"("user_id", "day");

-- CreateIndex
CREATE INDEX "security_events_created_at_idx" ON "security_events"("created_at");

-- CreateIndex
CREATE INDEX "security_events_type_created_at_idx" ON "security_events"("type", "created_at");

-- CreateIndex
CREATE INDEX "security_events_user_id_created_at_idx" ON "security_events"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "offering_slots" ADD CONSTRAINT "offering_slots_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "course_offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "course_offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_request_events" ADD CONSTRAINT "service_request_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "library_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_reservations" ADD CONSTRAINT "library_reservations_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "library_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_reservations" ADD CONSTRAINT "library_reservations_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_bookings" ADD CONSTRAINT "room_bookings_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alumni_profiles" ADD CONSTRAINT "alumni_profiles_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job_postings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "theses" ADD CONSTRAINT "theses_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "theses" ADD CONSTRAINT "theses_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "teachers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "theses" ADD CONSTRAINT "theses_co_supervisor_id_fkey" FOREIGN KEY ("co_supervisor_id") REFERENCES "teachers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thesis_milestones" ADD CONSTRAINT "thesis_milestones_thesis_id_fkey" FOREIGN KEY ("thesis_id") REFERENCES "theses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thesis_submissions" ADD CONSTRAINT "thesis_submissions_thesis_id_fkey" FOREIGN KEY ("thesis_id") REFERENCES "theses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thesis_events" ADD CONSTRAINT "thesis_events_thesis_id_fkey" FOREIGN KEY ("thesis_id") REFERENCES "theses"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Defaults so every school (existing and new) can use the library and the timetable engine immediately.
INSERT INTO "library_settings" ("id", "updated_at") VALUES ('main', CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING;
INSERT INTO "timetable_periods" ("id", "key", "label", "start_time", "end_time", "sort_order") VALUES
  ('per-p1', 'P1', 'Period 1', '08:00', '09:00', 1), ('per-p2', 'P2', 'Period 2', '09:00', '10:00', 2),
  ('per-p3', 'P3', 'Period 3', '10:15', '11:15', 3), ('per-p4', 'P4', 'Period 4', '11:15', '12:15', 4),
  ('per-p5', 'P5', 'Period 5', '14:00', '15:00', 5), ('per-p6', 'P6', 'Period 6', '15:00', '16:00', 6),
  ('per-p7', 'P7', 'Period 7', '16:15', '17:15', 7), ('per-p8', 'P8', 'Period 8', '17:15', '18:15', 8)
ON CONFLICT ("key") DO NOTHING;
