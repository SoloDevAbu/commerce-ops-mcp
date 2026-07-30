ALTER TABLE "orders" ADD COLUMN "order_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "order_id" SET DATA TYPE uuid USING "order_id"::uuid;--> statement-breakpoint
ALTER TABLE "fulfillment" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "fulfillment" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "fulfillment" ALTER COLUMN "order_id" SET DATA TYPE uuid USING "order_id"::uuid;--> statement-breakpoint
ALTER TABLE "order_events" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "order_events" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "order_events" ALTER COLUMN "order_id" SET DATA TYPE uuid USING "order_id"::uuid;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "order_id" SET DATA TYPE uuid USING "order_id"::uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_order_id_key" UNIQUE("order_id");