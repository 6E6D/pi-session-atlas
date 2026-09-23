// Exact known legacy-v3 schema, retained only for non-writing recognition.
export const LEGACY_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS catalog (
        file TEXT PRIMARY KEY,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        indexed_at TEXT NOT NULL,
        session_uuid TEXT NOT NULL,
        entry_count INTEGER NOT NULL,
        parse_warnings INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        uuid TEXT PRIMARY KEY,
        file TEXT NOT NULL UNIQUE,
        session_dir TEXT NOT NULL,
        cwd TEXT NOT NULL,
        name TEXT,
        first_user_text TEXT,
        parent_session TEXT,
        created TEXT NOT NULL,
        last_activity TEXT NOT NULL,
        entry_count INTEGER NOT NULL,
        user_msgs INTEGER NOT NULL,
        assistant_msgs INTEGER NOT NULL,
        tool_results INTEGER NOT NULL,
        models TEXT NOT NULL,
        cost_total REAL NOT NULL,
        tokens_in INTEGER NOT NULL,
        tokens_out INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        cache_write INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entries (
        session_uuid TEXT NOT NULL REFERENCES sessions(uuid) ON DELETE CASCADE,
        id TEXT NOT NULL,
        parent_id TEXT,
        type TEXT NOT NULL,
        role TEXT,
        ts TEXT NOT NULL,
        on_active_path INTEGER NOT NULL,
        child_count INTEGER NOT NULL,
        stop_reason TEXT,
        error_message TEXT,
        is_error INTEGER NOT NULL,
        model TEXT,
        provider TEXT,
        cost REAL NOT NULL,
        tokens_in INTEGER NOT NULL,
        tokens_out INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        PRIMARY KEY (session_uuid, id)
      );

      CREATE INDEX IF NOT EXISTS entries_parent_idx
        ON entries(session_uuid, parent_id);
      CREATE INDEX IF NOT EXISTS entries_ts_idx ON entries(ts);
      CREATE INDEX IF NOT EXISTS entries_terminal_idx
        ON entries(on_active_path, child_count, role, stop_reason);

      CREATE TABLE IF NOT EXISTS tool_calls (
        session_uuid TEXT NOT NULL REFERENCES sessions(uuid) ON DELETE CASCADE,
        entry_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        tool TEXT NOT NULL,
        path_raw TEXT,
        path_resolved TEXT,
        command TEXT,
        source TEXT NOT NULL,
        result_entry_id TEXT,
        exit_error INTEGER,
        PRIMARY KEY (session_uuid, entry_id, seq, source)
      );

      CREATE INDEX IF NOT EXISTS tool_calls_path_idx ON tool_calls(path_resolved);
      CREATE INDEX IF NOT EXISTS tool_calls_tool_idx ON tool_calls(tool);

      CREATE VIRTUAL TABLE IF NOT EXISTS text_fts USING fts5(
        content,
        kind UNINDEXED,
        session_uuid UNINDEXED,
        entry_id UNINDEXED,
        ts UNINDEXED,
        tokenize = 'porter unicode61'
      );

      PRAGMA user_version = 3;`;

export const ATLAS_APPLICATION_ID = 0x41544c53;
export const CURRENT_SCHEMA_SQL = LEGACY_SCHEMA_SQL
  .replace("parse_warnings INTEGER NOT NULL", "parse_warnings INTEGER NOT NULL, ctime_ms REAL NOT NULL, device REAL NOT NULL, inode REAL NOT NULL")
  .replace("PRAGMA user_version = 3", "PRAGMA user_version = 4") + `
  CREATE TABLE cache_metadata (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    identity TEXT NOT NULL,
    last_attempt TEXT,
    last_successful_scan TEXT
  );
  CREATE TABLE file_health (
    file TEXT PRIMARY KEY,
    message TEXT NOT NULL
  );
  PRAGMA application_id = ${ATLAS_APPLICATION_ID};
`;
