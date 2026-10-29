// Only opaque revisions leave Neon. The live engine computes these on its
// replica; neither project data nor connector/source credentials are streamed.
export const projectRealtimeSql = `
WITH targets AS (
  SELECT 'vercel:' || connection_id || ':' || remote_id AS target_id, project_id FROM vercel_projects
  UNION ALL
  SELECT replace(c.cache_key, 'control:report:1:', ''), r.project_id
    FROM wordpress_catalog c JOIN railway_projects r ON r.connection_id = split_part(c.cache_key, ':', 5)
      AND r.data::jsonb->'services' @> jsonb_build_array(jsonb_build_object('id', split_part(c.cache_key, ':', 6), 'environmentId', split_part(c.cache_key, ':', 7)))
    WHERE c.cache_key LIKE 'control:report:1:railway:%'
  UNION ALL SELECT 'wordpress:' || id, project_id FROM hosting_installations
  UNION ALL SELECT 'hosting:' || id, project_id FROM hosting_installations
), revisions AS (
  SELECT 'authorized' AS key, NULL::text AS project_id, 'auth' AS kind, '1' AS revision
  UNION ALL SELECT 'project:' || id, id, 'project', md5(data || COALESCE(client_id, '')) FROM projects WHERE workspace = 'live'
  UNION ALL SELECT 'client:' || id, NULL, 'workspace', md5(data) FROM clients WHERE workspace = 'live'
  UNION ALL SELECT 'service:' || id, project_id, 'project', md5(data) FROM services WHERE workspace = 'live'
  UNION ALL SELECT 'environment:' || id, project_id, 'project', md5(data) FROM environments WHERE workspace = 'live'
  UNION ALL SELECT 'access:' || id, project_id, 'project', md5(data) FROM accesses WHERE workspace = 'live'
  UNION ALL SELECT 'resource:' || id, NULL, 'all', md5(data) FROM resources WHERE workspace = 'live'
  UNION ALL SELECT 'inventory:' || id, project_id, 'project', md5(data) FROM inventories WHERE workspace = 'live'
  UNION ALL SELECT 'component:' || id, project_id, 'detail', md5(data) FROM components WHERE workspace = 'live'
  UNION ALL SELECT 'hosting:' || h.id, h.project_id, 'detail', md5(h.data || c.data || COALESCE(i.data, '') || COALESCE(c.secret_cipher, ''))
    FROM hosting_installations h JOIN hosting_connections c ON c.id = h.connection_id
    LEFT JOIN hosting_site_inventories i ON i.installation_id = h.id WHERE h.project_id IS NOT NULL
  UNION ALL SELECT 'vercel:' || p.connection_id || ':' || p.remote_id, p.project_id, 'detail', md5(p.data || p.observed_at || COALESCE(p.missing_since, '') || c.data || COALESCE(c.secret_cipher, ''))
    FROM vercel_projects p JOIN vercel_connections c ON c.id = p.connection_id WHERE p.project_id IS NOT NULL
  UNION ALL SELECT 'railway:' || p.connection_id || ':' || p.remote_id, p.project_id, 'detail', md5(p.data || p.observed_at || COALESCE(p.missing_since, '') || c.data || COALESCE(c.secret_cipher, ''))
    FROM railway_projects p JOIN railway_connections c ON c.id = p.connection_id WHERE p.project_id IS NOT NULL
  UNION ALL SELECT c.cache_key, t.project_id, 'detail', md5(c.data)
    FROM wordpress_catalog c JOIN targets t ON c.cache_key = 'control:report:1:' || t.target_id WHERE t.project_id IS NOT NULL
  UNION ALL SELECT 'update:' || id, project_id, 'detail', md5(data) FROM update_runs
  UNION ALL SELECT 'source:' || target_id, project_id, 'detail', md5(revision::text || secret_cipher) FROM update_sources
  UNION ALL SELECT 'maintenance:' || id, project_id, 'detail', md5(data) FROM maintenance_jobs
  UNION ALL SELECT 'release:' || cache_key, NULL, 'all', md5(data) FROM software_release_catalog
  UNION ALL SELECT 'activity:' || COALESCE(project_id, '*'), project_id, 'activity', md5(string_agg(md5(data), '' ORDER BY id))
    FROM activity WHERE workspace = 'live' GROUP BY project_id
)
SELECT r.key, r.project_id, r.kind, r.revision FROM revisions r
WHERE EXISTS (
  SELECT 1 FROM "session" s JOIN "user" u ON u.id = s."userId"
  WHERE s.id = $1 AND u.id = $2 AND u.email = $3 AND u."emailVerified" = true
    AND s."expiresAt" >= $4::timestamptz
)`;
