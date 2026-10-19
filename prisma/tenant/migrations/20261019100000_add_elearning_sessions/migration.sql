-- CreateEnum
CREATE TYPE "ElearningStatus" AS ENUM ('scheduled', 'live', 'ended', 'cancelled');

-- CreateTable
CREATE TABLE "elearning_sessions" (
    "id" TEXT NOT NULL,
    "class_id" TEXT NOT NULL,
    "subject_name" TEXT NOT NULL,
    "teacher_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "status" "ElearningStatus" NOT NULL DEFAULT 'scheduled',
    "room_name" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "elearning_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "elearning_session_attendance" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "student_id" TEXT,
    "teacher_id" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),
    "duration_seconds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "elearning_session_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "elearning_sessions_room_name_key" ON "elearning_sessions"("room_name");
CREATE INDEX "elearning_sessions_class_id_starts_at_idx" ON "elearning_sessions"("class_id", "starts_at");
CREATE INDEX "elearning_sessions_teacher_id_starts_at_idx" ON "elearning_sessions"("teacher_id", "starts_at");
CREATE INDEX "elearning_session_attendance_session_id_idx" ON "elearning_session_attendance"("session_id");
CREATE INDEX "elearning_session_attendance_session_id_user_id_idx" ON "elearning_session_attendance"("session_id", "user_id");

-- AddForeignKey
ALTER TABLE "elearning_sessions" ADD CONSTRAINT "elearning_sessions_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "elearning_sessions" ADD CONSTRAINT "elearning_sessions_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "elearning_session_attendance" ADD CONSTRAINT "elearning_session_attendance_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "elearning_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
