CREATE VIEW backup_platform_inventory AS
SELECT 'railway'::text AS provider, h.remote_id, h.project_id, h.observed_at, h.missing_since,
       h.data::jsonb AS remote, p.data::jsonb->>'name' AS project_name,
       p.data::jsonb->>'lifecycle' = 'active' AS active, c.secret_cipher IS NOT NULL AS configured,
       NULLIF(c.data::jsonb->>'error', '') IS NOT NULL AS connection_error
FROM railway_projects h
JOIN railway_connections c ON c.id = h.connection_id
LEFT JOIN projects p ON p.id = h.project_id AND p.workspace = 'live'
UNION ALL
SELECT 'vercel', h.remote_id, h.project_id, h.observed_at, h.missing_since,
       h.data::jsonb, p.data::jsonb->>'name',
       p.data::jsonb->>'lifecycle' = 'active', c.secret_cipher IS NOT NULL,
       NULLIF(c.data::jsonb->>'error', '') IS NOT NULL
FROM vercel_projects h
JOIN vercel_connections c ON c.id = h.connection_id
LEFT JOIN projects p ON p.id = h.project_id AND p.workspace = 'live';
