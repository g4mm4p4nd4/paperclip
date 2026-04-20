import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals } from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";

type GoalReader = Pick<Db, "select">;

export async function getDefaultCompanyGoal(db: GoalReader, companyId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.level, "company")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

export function goalService(db: Db) {
  async function buildUniqueSlug(
    companyId: string,
    desiredSlug: string | null | undefined,
    fallbackTitle: string | null | undefined,
    excludeGoalId?: string,
  ) {
    const baseSlug = normalizeAgentUrlKey(desiredSlug ?? fallbackTitle) ?? "goal";
    const existingRows = await db
      .select({ id: goals.id, slug: goals.slug })
      .from(goals)
      .where(eq(goals.companyId, companyId));
    const used = new Set(
      existingRows
        .filter((row) => row.id !== excludeGoalId)
        .map((row) => row.slug),
    );
    if (!used.has(baseSlug)) return baseSlug;
    let attempt = 2;
    while (used.has(`${baseSlug}-${attempt}`)) {
      attempt += 1;
    }
    return `${baseSlug}-${attempt}`;
  }

  return {
    list: (companyId: string) =>
      db.select().from(goals).where(eq(goals.companyId, companyId)).orderBy(asc(goals.createdAt), asc(goals.id)),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getBySlug: (companyId: string, slug: string) =>
      db
        .select()
        .from(goals)
        .where(and(eq(goals.companyId, companyId), eq(goals.slug, slug)))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    create: async (
      companyId: string,
      data: Omit<typeof goals.$inferInsert, "companyId" | "slug"> & { slug?: string | null },
    ) => {
      const slug = await buildUniqueSlug(companyId, data.slug, data.title);
      return db
        .insert(goals)
        .values({ ...data, companyId, slug })
        .returning()
        .then((rows) => rows[0]);
    },

    update: async (
      id: string,
      data: Partial<Omit<typeof goals.$inferInsert, "slug">> & { slug?: string | null },
    ) => {
      const existing = await db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const slug = data.slug !== undefined
        ? await buildUniqueSlug(existing.companyId, data.slug, data.title ?? existing.title, existing.id)
        : existing.slug;

      return db
        .update(goals)
        .set({ ...data, slug, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
