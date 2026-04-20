CREATE TABLE "company_operating_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_workspace_id" uuid,
	"package_root_path" text DEFAULT '.' NOT NULL,
	"last_review_source_hash" text,
	"last_reviewed_snapshot" jsonb,
	"last_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "slug" text;--> statement-breakpoint
WITH goal_slug_seed AS (
	SELECT
		"id",
		"company_id",
		COALESCE(
			NULLIF(
				trim(both '-' from regexp_replace(lower(coalesce("title", '')), '[^a-z0-9]+', '-', 'g')),
				''
			),
			'goal'
		) AS "base_slug",
		row_number() OVER (
			PARTITION BY
				"company_id",
				COALESCE(
					NULLIF(
						trim(both '-' from regexp_replace(lower(coalesce("title", '')), '[^a-z0-9]+', '-', 'g')),
						''
					),
					'goal'
				)
			ORDER BY "created_at", "id"
		) AS "ordinal"
	FROM "goals"
)
UPDATE "goals"
SET "slug" = CASE
	WHEN goal_slug_seed.ordinal = 1 THEN goal_slug_seed.base_slug
	ELSE goal_slug_seed.base_slug || '-' || goal_slug_seed.ordinal
END
FROM goal_slug_seed
WHERE "goals"."id" = goal_slug_seed."id";--> statement-breakpoint
ALTER TABLE "goals" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "company_operating_contracts" ADD CONSTRAINT "company_operating_contracts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_operating_contracts" ADD CONSTRAINT "company_operating_contracts_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_operating_contracts_company_idx" ON "company_operating_contracts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_operating_contracts_workspace_idx" ON "company_operating_contracts" USING btree ("project_workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goals_company_slug_idx" ON "goals" USING btree ("company_id","slug");
