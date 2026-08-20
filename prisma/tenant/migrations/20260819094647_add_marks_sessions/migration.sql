-- CreateTable
CREATE TABLE "marks_sessions" (
    "id" TEXT NOT NULL,
    "label" TEXT,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marks_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marks_sessions_start_at_end_at_idx" ON "marks_sessions"("start_at", "end_at");
