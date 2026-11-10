import { ApiError } from "./http";
import { z } from "zod";
import { activityDetail, database, readActivity, requireProject, visibleActivity } from "./db";
import { activityCategories, activityKinds, activityViews, assessmentChangeActivity, automaticControlActivity, inventoryActivity, repeatableActivityFailures } from "./activity-model";
import { isPostgres } from "./storage";
import type { Workspace } from "./types";

const filtersSchema = z.object({
  query: z.string().trim().max(300).default(""),
  projectId: z.string().uuid().optional(),
  kind: z.enum(activityKinds).optional(),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(0).max(40_000).default(0),
  view: z.enum(activityViews).optional(),
});
const pageSize = 25;
const actionCode = "json_extract(data,'$.action')";
const action = `LOWER(${actionCode})`;
const createdAt = "json_extract(data,'$.createdAt')";
const collectionKey = `COALESCE(
  CASE WHEN ${actionCode}='${inventoryActivity}' THEN 'collection:' || NULLIF(json_extract(data,'$.collectionId'),'') END,
  'event:' || id
)`;

function incidentEntryKey() {
  const postgres = isPostgres();
  const day = postgres ? `to_char(CAST(${createdAt} AS timestamptz) AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD')` : `activity_paris_day(${createdAt})`;
  const detail = `CASE WHEN ${actionCode} <> '${automaticControlActivity}' THEN ${activityDetail} END`;
  const key = postgres
    ? `CAST(jsonb_build_array(${day}, ${actionCode}, project_id, ${detail}) AS text)`
    : `json_array(${day}, ${actionCode}, project_id, ${detail})`;
  const repeatable = [automaticControlActivity, ...repeatableActivityFailures].map(action => `'${action}'`).join(", ");
  return `CASE WHEN ${actionCode} IN (${repeatable}) THEN ${key} ELSE 'event:' || id END`;
}

export async function activityPage(raw: unknown, workspace: Workspace) {
  const filters = filtersSchema.parse(raw), where = ["workspace=?", visibleActivity], args: (string | number)[] = [workspace];
  if (filters.projectId) { await requireProject(filters.projectId, workspace); where.push("project_id=?"); args.push(filters.projectId); }
  if (filters.view === "focus") {
    where.push(`(
      ${action} = '${assessmentChangeActivity}'
      OR ${action} LIKE '%.failed'
      OR ${action} LIKE '%!_failed' ESCAPE '!'
      OR REPLACE(${action}, 'É', 'é') LIKE '%échec%'
      OR (${action} = '${automaticControlActivity}'
        AND ${activityDetail} LIKE '%, % échec(s), %'
        AND ${activityDetail} NOT LIKE '%, 0 échec(s), %')
    )`);
  }
  if (filters.query) {
    const text = ["json_extract(data,'$.projectName')", activityDetail, "json_extract(data,'$.actorName')", "json_extract(data,'$.action')"]
      .map(value => `COALESCE(${value},'')`).join(" || ' ' || ");
    where.push(`LOWER(${text}) LIKE ? ESCAPE '\\'`);
    args.push("%" + filters.query.toLowerCase().replace(/[\\%_]/g, "\\$&") + "%");
  }
  if (filters.kind) {
    const cases = Object.entries(activityCategories).filter(([, words]) => words.length).map(([category, words]) => `WHEN ${words.map(word => `${action} LIKE '%${word}%'`).join(" OR ")} THEN '${category}'`).join(" ");
    where.push(`(CASE ${cases} ELSE 'Modifications' END)=?`); args.push(filters.kind);
  }
  if (filters.since) {
    const date = new Date(filters.since + "T00:00:00.000Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== filters.since) throw new ApiError("Date de filtre invalide.");
    const hour = Number(new Intl.DateTimeFormat("en", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" }).format(date));
    where.push(`${createdAt}>=?`); args.push(new Date(date.getTime() - hour * 3_600_000).toISOString());
  }
  const clause = where.join(" AND ");
  const entryKey = filters.view === "focus" ? incidentEntryKey() : filters.view === "complete" ? collectionKey : null;
  const db = database();
  const count = await db.prepare(`SELECT COUNT(${entryKey ? `DISTINCT ${entryKey}` : "*"}) AS total FROM activity WHERE ${clause}`)
    .get(...args) as { total: string | number };
  const total = Number(count.total);
  const page = Math.min(filters.page, Math.max(0, Math.ceil(total / pageSize) - 1));
  // Apply filters first, then paginate entries so each group stays on one page.
  const pageSql = entryKey ? `
    WITH filtered AS (
      SELECT id, data, ${activityDetail} AS detail, ${createdAt} AS created_at, ${entryKey} AS entry_key
      FROM activity WHERE ${clause}
    ), entries AS (
      SELECT entry_key, MAX(created_at) AS latest_at FROM filtered
      GROUP BY entry_key ORDER BY latest_at DESC, entry_key DESC LIMIT ? OFFSET ?
    )
    SELECT filtered.data, filtered.detail FROM entries JOIN filtered USING (entry_key)
    ORDER BY entries.latest_at DESC, entries.entry_key DESC, filtered.created_at DESC, filtered.id DESC
  ` : `
    SELECT data, ${activityDetail} AS detail FROM activity WHERE ${clause}
    ORDER BY ${createdAt} DESC, id DESC LIMIT ? OFFSET ?
  `;
  const rows = await db.prepare(pageSql).all(...args, pageSize, page * pageSize) as Parameters<typeof readActivity>[0][];
  return { items: rows.map(readActivity), total, page, pageSize };
}
