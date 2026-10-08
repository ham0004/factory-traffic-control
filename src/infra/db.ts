import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));

export type Db = Database.Database;

export function openDatabase(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  // WAL lets the dashboard read while a junction update is being written.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  return db;
}

// Only inserts when the junction is missing, so a restart never overwrites edited config.
export function seedJunction(db: Db, id: string, name: string, config: object): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO junctions (id, name, config_json, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, name, JSON.stringify(config), new Date().toISOString());
  return result.changes > 0;
}
