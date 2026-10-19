-- CreateEnum
CREATE TYPE "PaymentTxStatus" AS ENUM ('initiated', 'pending', 'processing', 'successful', 'failed', 'cancelled', 'awaiting_verification', 'refunded', 'expired');
-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'finance_officer';
-- AlterTable
ALTER TABLE "fee_records" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'XAF';
-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'payment',
ADD COLUMN     "recorded_by" TEXT,
ADD COLUMN     "reverses_payment_id" TEXT,
ADD COLUMN     "transaction_id" TEXT;
-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "fee_record_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "PaymentTxStatus" NOT NULL DEFAULT 'initiated',
    "provider_ref" TEXT,
    "provider_txn_id" TEXT,
    "provider_secret" TEXT,
    "payer_phone" TEXT,
    "checkout_url" TEXT,
    "idempotency_key" TEXT,
    "failure_reason" TEXT,
    "bank_reference" TEXT,
    "receipt_name" TEXT,
    "receipt_mime" TEXT,
    "receipt_size" INTEGER,
    "receipt_data" BYTEA,
    "initiated_by" TEXT,
    "verified_by" TEXT,
    "verified_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "review_note" TEXT,
    "refunded_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "payment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "payment_events" (
    "id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_name" TEXT,
    "note" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "payload" JSONB,
    "outcome" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "finance_audit" (
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
    CONSTRAINT "finance_audit_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_reference_key" ON "payment_transactions"("reference");
-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_payment_id_key" ON "payment_transactions"("payment_id");
-- CreateIndex
CREATE INDEX "payment_transactions_fee_record_id_idx" ON "payment_transactions"("fee_record_id");
-- CreateIndex
CREATE INDEX "payment_transactions_student_id_created_at_idx" ON "payment_transactions"("student_id", "created_at");
-- CreateIndex
CREATE INDEX "payment_transactions_status_created_at_idx" ON "payment_transactions"("status", "created_at");
-- CreateIndex
CREATE INDEX "payment_transactions_provider_status_idx" ON "payment_transactions"("provider", "status");
-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_student_id_idempotency_key_key" ON "payment_transactions"("student_id", "idempotency_key");
-- CreateIndex
CREATE INDEX "payment_events_transaction_id_created_at_idx" ON "payment_events"("transaction_id", "created_at");
-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_provider_event_id_key" ON "payment_webhook_events"("provider", "event_id");
-- CreateIndex
CREATE INDEX "finance_audit_created_at_idx" ON "finance_audit"("created_at");
-- CreateIndex
CREATE INDEX "finance_audit_target_type_target_id_idx" ON "finance_audit"("target_type", "target_id");
-- CreateIndex
CREATE INDEX "students_is_active_idx" ON "students"("is_active");
-- CreateIndex
CREATE INDEX "fee_records_status_idx" ON "fee_records"("status");
-- CreateIndex
CREATE INDEX "fee_records_class_id_idx" ON "fee_records"("class_id");
-- CreateIndex
CREATE INDEX "fee_records_academic_year_idx" ON "fee_records"("academic_year");
-- CreateIndex
CREATE UNIQUE INDEX "payments_transaction_id_key" ON "payments"("transaction_id");
-- CreateIndex
CREATE INDEX "payments_fee_record_id_idx" ON "payments"("fee_record_id");
-- CreateIndex
CREATE INDEX "forum_messages_thread_id_created_at_idx" ON "forum_messages"("thread_id", "created_at");
-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_fee_record_id_fkey" FOREIGN KEY ("fee_record_id") REFERENCES "fee_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "payment_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Receipt numbers: one gapless-enough, race-free counter per tenant schema
CREATE SEQUENCE IF NOT EXISTS "receipt_seq";
