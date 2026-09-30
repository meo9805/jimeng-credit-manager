// Account ownership is independent of operation evidence. These server-owned
// history records audit decisions; reporting always uses the current mapping.
const MIGRATION = 'identity-ownership-history-v1';
const emptyOwner = {employeeId:null,name:null,departmentId:null,department:null};

export function createOwnershipHistory(db, now) {
  const current = platformUserId => {
    const row = db.prepare(`SELECT e.id AS employeeId,e.name,
      COALESCE(e.department_id,m.department_id) AS departmentId,d.name AS department
      FROM identity_mappings m LEFT JOIN employees e ON e.id=m.employee_id
      LEFT JOIN departments d ON d.id=COALESCE(e.department_id,m.department_id)
      WHERE m.platform_user_id=?`).get(platformUserId);
    return row ? {...row} : {...emptyOwner};
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    // No foreign key to the current directory: deletion must not erase history.
    db.exec(`CREATE TABLE IF NOT EXISTS identity_ownership_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,platform_user_id TEXT NOT NULL,
      effective_at TEXT NOT NULL,is_baseline INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS identity_ownership_time ON identity_ownership_history(platform_user_id,effective_at,sequence);
      INSERT OR IGNORE INTO data_revisions(name,revision) VALUES('ownership',0);
      CREATE TRIGGER IF NOT EXISTS ownership_revision_insert AFTER INSERT ON identity_ownership_history
        BEGIN UPDATE data_revisions SET revision=revision+1 WHERE name='ownership'; END;
      CREATE TRIGGER IF NOT EXISTS ownership_revision_update AFTER UPDATE ON identity_ownership_history
        BEGIN UPDATE data_revisions SET revision=revision+1 WHERE name='ownership'; END;
      CREATE TRIGGER IF NOT EXISTS ownership_revision_delete AFTER DELETE ON identity_ownership_history
        BEGIN UPDATE data_revisions SET revision=revision+1 WHERE name='ownership'; END;`);
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(MIGRATION)) {
      const startedAt=now();
      for (const row of db.prepare('SELECT platform_user_id FROM identity_mappings').all()) {
        db.prepare('INSERT INTO identity_ownership_history(platform_user_id,effective_at,is_baseline,data) VALUES(?,?,1,?)')
          .run(row.platform_user_id,startedAt,JSON.stringify(current(row.platform_user_id)));
      }
      db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(MIGRATION,startedAt);
    }
    db.exec('COMMIT');
  } catch(error) {if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  const startedAt=db.prepare('SELECT applied_at FROM schema_migrations WHERE id=?').get(MIGRATION).applied_at;
  const unassigned=Object.freeze({...emptyOwner,basis:'effective',effectiveAt:startedAt});
  let cache=null;
  function record(platformUserId) {
    const data=JSON.stringify(current(platformUserId));
    const last=db.prepare('SELECT data,effective_at FROM identity_ownership_history WHERE platform_user_id=? ORDER BY effective_at DESC,sequence DESC LIMIT 1').get(platformUserId);
    if(last?.data===data)return;
    // A clock correction cannot move a new decision before an existing one.
    const effectiveAt=[now(),last?.effective_at??startedAt].sort().at(-1);
    db.prepare('INSERT INTO identity_ownership_history(platform_user_id,effective_at,data) VALUES(?,?,?)').run(platformUserId,effectiveAt,data);
  }
  function view() {
    const revision=db.prepare("SELECT revision FROM data_revisions WHERE name='ownership'").get().revision;
    if(cache?.revision===revision)return cache;
    const mappings=new Map(db.prepare('SELECT platform_user_id,updated_at FROM identity_mappings').all().map(row=>[
      row.platform_user_id,Object.freeze({...current(row.platform_user_id),basis:'current_mapping',effectiveAt:row.updated_at})
    ]));
    const resolve=platformUserId=>mappings.get(platformUserId)??unassigned;
    cache={revision,resolve};return cache;
  }
  return {record,view};
}
