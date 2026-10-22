import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type SqliteDb = InstanceType<typeof Database>;

export function openDatabase(path: string): SqliteDb {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get();
  if (!applied) {
    const migration = readFileSync(resolve(process.cwd(), 'migrations/001_init.sql'), 'utf8');
    db.transaction(() => {
      db.exec(migration);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(Date.now());
    })();
  }
  return db;
}