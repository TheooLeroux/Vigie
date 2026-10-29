import { ApiError } from "./http";
import { z } from "zod";
import { database, requireProject } from "./db";
import { activityCategories } from "./activity-model";
import type { Activity, Workspace } from "./types";
const filtersSchema = z.object({ query: z.string().trim().max(300).default(""), projectId: z.string().uuid().optional(), kind: z.enum(["Ajouts", "Revues", "Connexions & relevés", "Modifications"]).optional(), since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), page: z.coerce.number().int().min(0).max(40_000).default(0) });
export async function activityPage(raw: unknown, workspace: Workspace) {
  const filters = filtersSchema.parse(raw), where = ["workspace=?"], args: (string | number)[] = [workspace];
  if (filters.projectId) { await requireProject(filters.projectId, workspace); where.push("project_id=?"); args.push(filters.projectId); }
  if (filters.query) {
    const text = ["projectName", "detail", "actorName", "action"].map(key => `COALESCE(json_extract(data,'$.${key}'),'')`).join(" || ' ' || ");
    where.push(`LOWER(${text}) LIKE ? ESCAPE '\\'`);
    args.push("%" + filters.query.toLowerCase().replace(/[\\%_]/g, "\\$&") + "%");
  }
  if (filters.kind) {
    const action = "LOWER(json_extract(data,'$.action'))";
    const cases = Object.entries(activityCategories).filter(([, words]) => words.length).map(([category, words]) => `WHEN ${words.map(word => `${action} LIKE '%${word}%'`).join(" OR ")} THEN '${category}'`).join(" ");
    where.push(`(CASE ${cases} ELSE 'Modifications' END)=?`); args.push(filters.kind);
  }
  if (filters.since) {
    const date = new Date(filters.since + "T00:00:00.000Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== filters.since) throw new ApiError("Date de filtre invalide.");
    const hour = Number(new Intl.DateTimeFormat("en", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" }).format(date));
    where.push("json_extract(data,'$.createdAt')>=?"); args.push(new Date(date.getTime() - hour * 3_600_000).toISOString());
  }
  const clause = where.join(" AND ");
  const total = Number((await database().prepare(`SELECT COUNT(*) AS total FROM activity WHERE ${clause}`).get(...args) as { total: number }).total);
  const page = Math.min(filters.page, Math.max(0, Math.ceil(total / 25) - 1));
  const rows = await database().prepare(`SELECT data FROM activity WHERE ${clause} ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT ? OFFSET ?`).all(...args, 25, page * 25) as { data: string }[];
  return { items: rows.map(row => JSON.parse(row.data) as Activity), total, page, pageSize: 25 };
}
