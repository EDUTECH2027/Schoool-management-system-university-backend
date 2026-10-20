-- CreateTable
CREATE TABLE "academic_audit" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_name" TEXT,
    "actor_role" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academic_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "academic_audit_created_at_idx" ON "academic_audit"("created_at");

-- CreateIndex
CREATE INDEX "academic_audit_target_type_target_id_idx" ON "academic_audit"("target_type", "target_id");

