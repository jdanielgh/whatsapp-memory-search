CREATE TABLE IF NOT EXISTS "message_processing_state" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'PERSISTED' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_processing_state" ADD CONSTRAINT "message_processing_state_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
