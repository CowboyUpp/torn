// Nuclear Family backend maintenance routes
// v6.7.4 backend support
//
// Purpose:
//   Adds guarded backend support for the userscript Database Tools panel:
//   - POST /admin/dev-reset
//   - GET/POST /admin/archive
//
// Integration:
//   In your Cloudflare Worker fetch handler, call:
//
//     const maintenanceResponse = await handleAdminMaintenanceRoutes(request, env, ctx, {
//       authenticateAdmin: yourExistingAdminAuthFunction
//     });
//     if (maintenanceResponse) return maintenanceResponse;
//
//   authenticateAdmin should return an identity object like:
//     { ok:true, role:'super_admin', id:'...', name:'...' }
//
//   If no authenticateAdmin hook is supplied, this module falls back to env.ADMIN_TOKEN
//   or env.SUPER_ADMIN_TOKEN and treats a matching Bearer token as super_admin.
//
// Safety model:
//   - No raw SQL is accepted from the client.
//   - All table names are server-side allowlisted.
//   - Destructive calls require super_admin and body.confirm === 'DELETE'.
//   - Missing tables are skipped, not fatal.

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
};

const RESET_SCOPES = {
  standings: [
    'championship_standings',
    'standings_cache',
    'series_standings',
    'round_standings',
  ],
  assignments: [
    'championship_race_assignments',
    'race_assignments',
    'event_race_assignments',
    'round_race_assignments',
  ],
  events: [
    'championship_race_assignments',
    'race_assignments',
    'event_race_assignments',
    'round_race_assignments',
    'championship_standings',
    'standings_cache',
    'championship_events',
    'series_events',
    'rounds',
  ],
  seasons: [
    'championship_race_assignments',
    'race_assignments',
    'event_race_assignments',
    'round_race_assignments',
    'championship_standings',
    'standings_cache',
    'championship_events',
    'series_events',
    'rounds',
    'championship_seasons',
    'series_splits',
  ],
  competitions: [
    'competition_participants',
    'series_participants',
    'competition_templates',
    'competitions',
    'series',
  ],
  uploaded_races: [
    'championship_race_assignments',
    'race_assignments',
    'event_race_assignments',
    'round_race_assignments',
    'championship_standings',
    'standings_cache',
    'race_results',
    'uploaded_race_results',
    'uploaded_races',
    'race_uploads',
    'ingested_races',
  ],
  factory: [
    'championship_race_assignments',
    'race_assignments',
    'event_race_assignments',
    'round_race_assignments',
    'championship_standings',
    'standings_cache',
    'race_results',
    'uploaded_race_results',
    'uploaded_races',
    'race_uploads',
    'ingested_races',
    'competition_participants',
    'series_participants',
    'championship_events',
    'series_events',
    'rounds',
    'championship_seasons',
    'series_splits',
    'competition_templates',
    'competitions',
    'series',
  ],
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS,
  });
}

function getBearerToken(request) {
  const raw = request.headers.get('authorization') || request.headers.get('Authorization') || '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function defaultAuthenticateAdmin(request, env) {
  const token = getBearerToken(request);
  if (!token) return { ok: false, role: 'anonymous', error: 'missing bearer token' };

  if (env.SUPER_ADMIN_TOKEN && token === env.SUPER_ADMIN_TOKEN) {
    return { ok: true, role: 'super_admin', source: 'SUPER_ADMIN_TOKEN' };
  }

  if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) {
    return { ok: true, role: 'super_admin', source: 'ADMIN_TOKEN' };
  }

  if (env.ADMIN_TOKENS) {
    try {
      const map = JSON.parse(env.ADMIN_TOKENS);
      const identity = map[token];
      if (identity) {
        return {
          ok: true,
          role: identity.role || 'admin',
          id: identity.id || '',
          name: identity.name || '',
          source: 'ADMIN_TOKENS',
        };
      }
    } catch (err) {
      return { ok: false, role: 'anonymous', error: 'invalid ADMIN_TOKENS json' };
    }
  }

  return { ok: false, role: 'anonymous', error: 'invalid admin token' };
}

async function requireSuperAdmin(request, env, options) {
  const authFn = options && typeof options.authenticateAdmin === 'function'
    ? options.authenticateAdmin
    : defaultAuthenticateAdmin;

  const identity = await authFn(request, env);
  if (!identity || !identity.ok) {
    return { ok: false, response: json({ ok: false, error: identity && identity.error ? identity.error : 'unauthorized' }, 401) };
  }

  if (identity.role !== 'super_admin') {
    return { ok: false, response: json({ ok: false, error: 'super_admin required', role: identity.role || 'unknown' }, 403) };
  }

  return { ok: true, identity };
}

function getDb(env) {
  return env.DB || env.D1 || env.NUCLEAR_DB || env.NUCLEAR_FAMILY_DB || null;
}

async function tableExists(db, tableName) {
  const row = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1"
  ).bind(tableName).first();
  return !!row;
}

async function deleteAllFromTable(db, tableName) {
  // tableName is never client-supplied. It comes only from RESET_SCOPES.
  const exists = await tableExists(db, tableName);
  if (!exists) return { table: tableName, skipped: true, reason: 'missing table', deleted: null };

  const before = await db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).first();
  await db.prepare(`DELETE FROM ${tableName}`).run();
  const after = await db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).first();

  return {
    table: tableName,
    skipped: false,
    deleted: Math.max(0, Number(before && before.count || 0) - Number(after && after.count || 0)),
  };
}

async function clearScope(db, scope) {
  const tables = RESET_SCOPES[scope];
  if (!tables) throw new Error('unknown reset scope: ' + scope);

  const results = [];
  for (const table of tables) {
    results.push(await deleteAllFromTable(db, table));
  }

  return results;
}

async function archiveSeries(request, env, options) {
  const auth = await requireSuperAdmin(request, env, options);
  if (!auth.ok) return auth.response;

  const db = getDb(env);
  if (!db) return json({ ok: false, error: 'D1 binding missing. Expected env.DB.' }, 500);

  if (request.method === 'GET') {
    return json({
      ok: true,
      installed: true,
      endpoint: '/admin/archive',
      methods: ['GET', 'POST'],
      note: 'POST can mark a series/competition as archived when a compatible table exists.',
    });
  }

  let body = {};
  try { body = await request.json(); } catch (err) {}

  const id = body.id || body.series_id || body.competition_id;
  if (!id) return json({ ok: false, error: 'series id required' }, 400);

  const candidateTables = ['series', 'competitions'];
  const archived = [];

  for (const table of candidateTables) {
    if (!(await tableExists(db, table))) continue;

    const info = await db.prepare(`PRAGMA table_info(${table})`).all();
    const columns = (info.results || []).map((r) => r.name);

    if (columns.includes('archived_at')) {
      await db.prepare(`UPDATE ${table} SET archived_at = datetime('now') WHERE id = ?`).bind(id).run();
      archived.push({ table, column: 'archived_at' });
    } else if (columns.includes('status')) {
      await db.prepare(`UPDATE ${table} SET status = 'archived' WHERE id = ?`).bind(id).run();
      archived.push({ table, column: 'status' });
    }
  }

  if (!archived.length) {
    return json({ ok: false, error: 'no compatible archive column found', tried: candidateTables }, 400);
  }

  return json({ ok: true, archived, id });
}

async function devReset(request, env, options) {
  const auth = await requireSuperAdmin(request, env, options);
  if (!auth.ok) return auth.response;

  const db = getDb(env);
  if (!db) return json({ ok: false, error: 'D1 binding missing. Expected env.DB.' }, 500);

  let body = {};
  try { body = await request.json(); } catch (err) {}

  if (body.confirm !== 'DELETE') {
    return json({ ok: false, error: 'typed confirmation required', required: 'DELETE' }, 400);
  }

  const scope = String(body.scope || '').trim();
  if (!RESET_SCOPES[scope]) {
    return json({ ok: false, error: 'unknown reset scope', supported_scopes: Object.keys(RESET_SCOPES) }, 400);
  }

  const results = await clearScope(db, scope);
  const deletedTotal = results.reduce((sum, r) => sum + Number(r.deleted || 0), 0);

  return json({
    ok: true,
    scope,
    deleted_total: deletedTotal,
    results,
    warning: 'Development reset executed. This cannot be undone.',
  });
}

export async function handleAdminMaintenanceRoutes(request, env, ctx, options = {}) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });

  if (url.pathname === '/admin/dev-reset') {
    if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
    return devReset(request, env, options);
  }

  if (url.pathname === '/admin/archive') {
    if (request.method !== 'GET' && request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
    return archiveSeries(request, env, options);
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const response = await handleAdminMaintenanceRoutes(request, env, ctx);
    if (response) return response;
    return json({ ok: false, error: 'not found' }, 404);
  },
};
