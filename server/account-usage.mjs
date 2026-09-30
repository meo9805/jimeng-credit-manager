// A login is a many-to-many observation, not an ownership decision.
export function createAccountUsage(db, now) {
  db.exec(`CREATE TABLE IF NOT EXISTS account_usage (
    installation_id TEXT NOT NULL,platform_user_id TEXT NOT NULL,employee_id TEXT,
    nickname TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,
    PRIMARY KEY(installation_id,platform_user_id));`);
  const save=db.prepare(`INSERT INTO account_usage VALUES(?,?,?,?,?,?)
    ON CONFLICT(installation_id,platform_user_id) DO UPDATE SET
      nickname=CASE WHEN excluded.last_seen_at>=last_seen_at THEN COALESCE(excluded.nickname,nickname) ELSE nickname END,
      first_seen_at=MIN(first_seen_at,excluded.first_seen_at),last_seen_at=MAX(last_seen_at,excluded.last_seen_at)`);
  function record(installationId,employeeId,userId,nickname,at) {
    if(!userId||!Number.isFinite(Date.parse(at)))return;
    save.run(installationId,String(userId),employeeId??null,nickname&&nickname!==userId?nickname:null,at,at);
  }
  const migration='account-usage-v1';
  if(!db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(migration)) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for(const row of db.prepare('SELECT id,employee_id,data FROM installations').all()) {
        const binding=JSON.parse(row.data).initialIdentityBinding;
        if(binding?.platformUserId)record(row.id,row.employee_id,binding.platformUserId,binding.displayName,binding.observedAt);
      }
      for(const table of ['credit_history_facts','subscription_facts','credit_source_facts']) {
        for(const row of db.prepare(`SELECT installation_id,collector_employee_id,login_user_id,MIN(read_at) first_at,MAX(read_at) last_at FROM ${table} GROUP BY installation_id,collector_employee_id,login_user_id`).all()) {
          record(row.installation_id,row.collector_employee_id,row.login_user_id,null,row.first_at);
          record(row.installation_id,row.collector_employee_id,row.login_user_id,null,row.last_at);
        }
      }
      for(const row of db.prepare('SELECT installation_id,employee_id,data FROM operation_evidence').all()) {
        const event=JSON.parse(row.data);record(row.installation_id,row.employee_id,event.userId,null,event.occurredAt);
      }
      db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(migration,now());
      db.exec('COMMIT');
    } catch(error) {if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  return {record,list:()=>db.prepare(`SELECT u.installation_id installationId,u.platform_user_id platformUserId,
    u.employee_id employeeId,e.name employeeName,d.name department,u.nickname,
    u.first_seen_at firstSeenAt,u.last_seen_at lastSeenAt FROM account_usage u
    LEFT JOIN employees e ON e.id=u.employee_id LEFT JOIN departments d ON d.id=e.department_id
    ORDER BY u.last_seen_at DESC,u.platform_user_id`).all()};
}
