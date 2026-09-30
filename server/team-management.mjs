import { fail, identifier } from './domain.mjs';

/** Administrative scope is separate from the platform's subscription status. */
export function createTeamManagement(db, now) {
  db.exec(`CREATE TABLE IF NOT EXISTS team_management (
    space_id TEXT PRIMARY KEY,
    archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
    archived_at TEXT,
    updated_at TEXT NOT NULL
  )`);

  const knownTeam = db.prepare(`SELECT 1 FROM teams WHERE space_id=?
    UNION SELECT 1 FROM accounts WHERE space_id=? AND scope IN ('team_total','team_member') LIMIT 1`);
  const read = db.prepare('SELECT space_id,archived,archived_at,updated_at FROM team_management WHERE space_id=?');
  const all = db.prepare('SELECT space_id,archived,archived_at,updated_at FROM team_management ORDER BY space_id');
  const write = db.prepare(`INSERT INTO team_management(space_id,archived,archived_at,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(space_id) DO UPDATE SET archived=excluded.archived,archived_at=excluded.archived_at,updated_at=excluded.updated_at`);
  const present = row => ({ spaceId: row.space_id, archived: row.archived === 1, archivedAt: row.archived_at, updatedAt: row.updated_at });

  function get(spaceId) {
    identifier(spaceId, '团队空间 ID');
    const row = read.get(spaceId);
    return row ? present(row) : { spaceId, archived: false, archivedAt: null, updatedAt: null };
  }

  function setArchived(spaceId, archived) {
    identifier(spaceId, '团队空间 ID');
    if (typeof archived !== 'boolean') fail('归档状态必须是布尔值');
    if (!knownTeam.get(spaceId, spaceId)) fail('团队不存在', 404);
    const current = get(spaceId);
    if (current.archived === archived) return current;
    const at = now();
    write.run(spaceId, archived ? 1 : 0, archived ? at : null, at);
    return get(spaceId);
  }

  return { get, list: () => all.all().map(present), setArchived };
}
