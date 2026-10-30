CREATE TABLE IF NOT EXISTS "message_metadata" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"language" text,
	"emoji_count" integer DEFAULT 0 NOT NULL,
	"emojis" text[] DEFAULT '{}'::text[] NOT NULL,
	"mentioned_participant_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"mentioned_raw_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_metadata_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_metadata" ADD CONSTRAINT "message_metadata_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
