WITH "role_skill_defaults" ("role", "desired_skills") AS (
	VALUES
		('default', jsonb_build_array('paperclipai/paperclip/paperclip-product-scope')),
		('ceo', jsonb_build_array('paperclipai/paperclip/paperclip-create-agent', 'paperclipai/paperclip/paperclip-product-scope', 'paperclipai/paperclip/paperclip-go-to-market', 'paperclipai/paperclip/para-memory-files')),
		('cto', jsonb_build_array('paperclipai/paperclip/paperclip-product-scope', 'paperclipai/paperclip/paperclip-backend-api-security', 'paperclipai/paperclip/paperclip-frontend-experience', 'paperclipai/paperclip/paperclip-integration-engineer', 'paperclipai/paperclip/paperclip-create-agent', 'paperclipai/paperclip/paperclip-create-plugin')),
		('cmo', jsonb_build_array('paperclipai/paperclip/paperclip-product-scope', 'paperclipai/paperclip/paperclip-go-to-market', 'paperclipai/paperclip/para-memory-files')),
		('cfo', jsonb_build_array('paperclipai/paperclip/paperclip-product-scope', 'paperclipai/paperclip/paperclip-go-to-market', 'paperclipai/paperclip/para-memory-files')),
		('skill_curator', jsonb_build_array('paperclipai/paperclip/paperclip-create-agent', 'paperclipai/paperclip/paperclip-product-scope', 'paperclipai/paperclip/para-memory-files')),
		('engineer', jsonb_build_array('paperclipai/paperclip/paperclip-product-scope', 'paperclipai/paperclip/paperclip-frontend-experience', 'paperclipai/paperclip/paperclip-backend-api-security', 'paperclipai/paperclip/paperclip-integration-engineer', 'paperclipai/paperclip/paperclip-create-plugin')),
		('integration_engineer', jsonb_build_array('paperclipai/paperclip/paperclip-product-scope', 'paperclipai/paperclip/paperclip-backend-api-security', 'paperclipai/paperclip/paperclip-integration-engineer')),
		('designer', jsonb_build_array('paperclipai/paperclip/paperclip-frontend-experience', 'paperclipai/paperclip/paperclip-product-scope', 'paperclipai/paperclip/para-memory-files')),
		('pm', jsonb_build_array('paperclipai/paperclip/paperclip-product-scope', 'paperclipai/paperclip/paperclip-go-to-market', 'paperclipai/paperclip/para-memory-files')),
		('qa', jsonb_build_array('paperclipai/paperclip/paperclip-product-scope', 'paperclipai/paperclip/paperclip-frontend-experience', 'paperclipai/paperclip/paperclip-backend-api-security')),
		('devops', jsonb_build_array('paperclipai/paperclip/paperclip-product-scope', 'paperclipai/paperclip/paperclip-backend-api-security', 'paperclipai/paperclip/paperclip-integration-engineer')),
		('researcher', jsonb_build_array('paperclipai/paperclip/paperclip-product-scope', 'paperclipai/paperclip/paperclip-go-to-market', 'paperclipai/paperclip/para-memory-files')),
		('general', jsonb_build_array('paperclipai/paperclip/paperclip-product-scope', 'paperclipai/paperclip/para-memory-files'))
)
UPDATE "agents"
SET
	"adapter_type" = 'hermes_local',
	"adapter_config" = COALESCE("adapter_config", '{}'::jsonb)
		|| jsonb_build_object(
			'model', 'deepseek-v4-flash',
			'provider', 'openrouter',
			'reasoningEffort', 'high',
			'yolo', true,
			'checkpoints', true,
			'passSessionId', true,
			'paperclipSkillSync',
			COALESCE("adapter_config"->'paperclipSkillSync', '{}'::jsonb)
				|| jsonb_build_object(
					'desiredSkills',
					(
						SELECT COALESCE(jsonb_agg(DISTINCT "desired_skill" ORDER BY "desired_skill"), '[]'::jsonb)
						FROM jsonb_array_elements_text(
							COALESCE("adapter_config"->'paperclipSkillSync'->'desiredSkills', '[]'::jsonb)
							|| COALESCE(
								(SELECT "desired_skills" FROM "role_skill_defaults" WHERE "role" = "agents"."role" LIMIT 1),
								(SELECT "desired_skills" FROM "role_skill_defaults" WHERE "role" = 'default' LIMIT 1)
							)
						) AS "desired" ("desired_skill")
					)
				)
		),
	"permissions" = COALESCE("permissions", '{}'::jsonb)
		|| jsonb_build_object('canBypassExecutionApprovals', true),
	"updated_at" = now();--> statement-breakpoint
INSERT INTO "agents" (
	"company_id",
	"name",
	"role",
	"title",
	"status",
	"reports_to",
	"capabilities",
	"adapter_type",
	"adapter_config",
	"runtime_config",
	"budget_monthly_cents",
	"spent_monthly_cents",
	"permissions"
)
SELECT
	"companies"."id",
	'Skill Curator',
	'skill_curator',
	'Skill Enablement Agent',
	'idle',
	(
		SELECT "ceo"."id"
		FROM "agents" "ceo"
		WHERE "ceo"."company_id" = "companies"."id"
			AND "ceo"."role" = 'ceo'
			AND "ceo"."status" <> 'terminated'
		ORDER BY "ceo"."created_at", "ceo"."id"
		LIMIT 1
	),
	'Keeps company skills shared, current, and assigned to agents by role and task.',
	'hermes_local',
	jsonb_build_object(
		'model', 'deepseek-v4-flash',
		'provider', 'openrouter',
		'reasoningEffort', 'high',
		'yolo', true,
		'checkpoints', true,
		'passSessionId', true,
		'paperclipSkillSync',
		jsonb_build_object(
			'desiredSkills',
			jsonb_build_array(
				'paperclipai/paperclip/paperclip',
				'paperclipai/paperclip/paperclip-create-agent',
				'paperclipai/paperclip/paperclip-product-scope',
				'paperclipai/paperclip/para-memory-files'
			)
		)
	),
	jsonb_build_object('heartbeat', jsonb_build_object('maxConcurrentRuns', 5)),
	0,
	0,
	jsonb_build_object('canCreateAgents', true, 'canBypassExecutionApprovals', true)
FROM "companies"
WHERE NOT EXISTS (
	SELECT 1
	FROM "agents" "existing"
	WHERE "existing"."company_id" = "companies"."id"
		AND "existing"."role" = 'skill_curator'
		AND "existing"."status" <> 'terminated'
);--> statement-breakpoint
INSERT INTO "company_memberships" (
	"company_id",
	"principal_type",
	"principal_id",
	"status",
	"membership_role"
)
SELECT
	"agents"."company_id",
	'agent',
	"agents"."id"::text,
	'active',
	'member'
FROM "agents"
WHERE "agents"."role" = 'skill_curator'
	AND "agents"."status" <> 'terminated'
ON CONFLICT ("company_id", "principal_type", "principal_id") DO UPDATE
SET
	"status" = 'active',
	"membership_role" = COALESCE("company_memberships"."membership_role", 'member'),
	"updated_at" = now();--> statement-breakpoint
INSERT INTO "principal_permission_grants" (
	"company_id",
	"principal_type",
	"principal_id",
	"permission_key",
	"scope",
	"granted_by_user_id"
)
SELECT
	"agents"."company_id",
	'agent',
	"agents"."id"::text,
	'tasks:assign',
	NULL,
	NULL
FROM "agents"
WHERE "agents"."role" = 'skill_curator'
	AND "agents"."status" <> 'terminated'
ON CONFLICT ("company_id", "principal_type", "principal_id", "permission_key") DO NOTHING;
