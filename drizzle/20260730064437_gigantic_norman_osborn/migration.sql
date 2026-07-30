CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY,
	"order_id" text NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"outcome" text NOT NULL,
	"performed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fulfillment" (
	"id" text PRIMARY KEY,
	"order_id" text NOT NULL UNIQUE,
	"status" text NOT NULL,
	"failure_reason" text,
	"started_at" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" text PRIMARY KEY,
	"order_id" text NOT NULL,
	"event_type" text NOT NULL,
	"description" text NOT NULL,
	"metadata" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY,
	"status" text NOT NULL,
	"customer_email" text NOT NULL,
	"amount" double precision NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"items" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"stuck_since" text
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY,
	"order_id" text NOT NULL UNIQUE,
	"internal_status" text NOT NULL,
	"provider_status" text NOT NULL,
	"amount" double precision NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"captured_at" text
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "fulfillment" ADD CONSTRAINT "fulfillment_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");