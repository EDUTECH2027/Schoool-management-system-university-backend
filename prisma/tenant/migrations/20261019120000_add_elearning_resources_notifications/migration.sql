-- AlterTable
ALTER TABLE "elearning_sessions" ADD COLUMN "reminder_sent_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "elearning_resources" (
    "id" TEXT NOT NULL,
    "class_id" TEXT NOT NULL,
    "subject_name" TEXT NOT NULL,
    "teacher_id" TEXT NOT NULL,
    "session_id" TEXT,
    "topic" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "file_key" TEXT,
    "original_name" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "elearning_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "elearning_resources_class_id_subject_name_idx" ON "elearning_resources"("class_id", "subject_name");
CREATE INDEX "elearning_resources_session_id_idx" ON "elearning_resources"("session_id");
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "elearning_resources" ADD CONSTRAINT "elearning_resources_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "elearning_resources" ADD CONSTRAINT "elearning_resources_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "elearning_resources" ADD CONSTRAINT "elearning_resources_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "elearning_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
