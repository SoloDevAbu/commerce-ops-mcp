ALTER TABLE "audit_log" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_idempotency_key_key" UNIQUE("idempotency_key");