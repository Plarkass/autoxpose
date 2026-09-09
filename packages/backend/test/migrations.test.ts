import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { closeDatabase, getDatabase } from '../src/core/database/index.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

type JournalEntry = { idx: number; when: number; tag: string };

function journal(): JournalEntry[] {
  const raw = readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf-8');
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries.sort((a, b) => a.idx - b.idx);
}

function applyMigration(db: Database.Database, tag: string): void {
  const sql = readFileSync(join(migrationsDir, `${tag}.sql`), 'utf-8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement);
  }
}

/** A database as autoxpose 0.4.2 left it: migrations 0000 and 0001, tracked. */
function createPreAccessListDatabase(path: string, options: { tracked: boolean }): void {
  const db = new Database(path);
  db.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT NOT NULL,
    created_at INTEGER
  )`);

  for (const entry of journal().filter(e => e.idx <= 1)) {
    applyMigration(db, entry.tag);
    if (options.tracked) {
      db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(
        entry.tag,
        entry.when
      );
    }
  }

  db.prepare(
    `INSERT INTO services (id, name, subdomain, port, source) VALUES ('svc-1', 'grafana', 'grafana', 3000, 'docker')`
  ).run();
  db.close();
}

function columns(path: string, table: string): string[] {
  const db = new Database(path, { readonly: true });
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  db.close();
  return rows.map(r => r.name);
}

function tables(path: string): string[] {
  const db = new Database(path, { readonly: true });
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
    name: string;
  }[];
  db.close();
  return rows.map(r => r.name);
}

function appliedMigrations(path: string): { hash: string; created_at: number }[] {
  const db = new Database(path, { readonly: true });
  const rows = db
    .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at')
    .all() as { hash: string; created_at: number }[];
  db.close();
  return rows;
}

describe('migrations', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'autoxpose-migrations-'));
  });

  after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('journal timestamps are strictly increasing so no migration is skipped', () => {
    const entries = journal();
    for (let i = 1; i < entries.length; i++) {
      assert.ok(
        entries[i].when > entries[i - 1].when,
        `${entries[i].tag} (when=${entries[i].when}) must be newer than ${entries[i - 1].tag} (when=${entries[i - 1].when})`
      );
    }
  });

  it('upgrades a tracked database from the previous release', () => {
    const path = join(dir, 'tracked.db');
    createPreAccessListDatabase(path, { tracked: true });

    getDatabase(path);
    closeDatabase();

    assert.ok(tables(path).includes('npm_access_lists'), 'npm_access_lists table was created');
    const serviceColumns = columns(path, 'services');
    assert.ok(serviceColumns.includes('access_list_id'), 'services.access_list_id was added');
    assert.ok(serviceColumns.includes('access_list_name'), 'services.access_list_name was added');
  });

  it('is idempotent across restarts', () => {
    const path = join(dir, 'restart.db');
    createPreAccessListDatabase(path, { tracked: true });

    getDatabase(path);
    closeDatabase();
    const first = appliedMigrations(path);

    getDatabase(path);
    closeDatabase();
    const second = appliedMigrations(path);

    assert.deepEqual(second, first, 'a second startup applies nothing further');
    assert.equal(second.length, journal().length);
  });

  it('recovers a legacy database that has no migration tracking', () => {
    const path = join(dir, 'legacy.db');
    createPreAccessListDatabase(path, { tracked: false });
    new Database(path).exec('DROP TABLE __drizzle_migrations');

    getDatabase(path);
    closeDatabase();

    assert.ok(tables(path).includes('npm_access_lists'), 'npm_access_lists table was created');
    assert.ok(columns(path, 'services').includes('access_list_id'));

    // Recovery must not backdate future migrations out of existence: the marker
    // rows carry the journal timestamps, not the wall clock.
    const applied = appliedMigrations(path);
    assert.equal(applied.length, journal().length);
    for (const row of applied) {
      assert.ok(
        row.created_at <= journal()[journal().length - 1].when,
        `${row.hash} recorded with a journal timestamp, got ${row.created_at}`
      );
    }
  });

  it('preserves existing rows through the upgrade', () => {
    const path = join(dir, 'data.db');
    createPreAccessListDatabase(path, { tracked: true });

    getDatabase(path);
    closeDatabase();

    const db = new Database(path, { readonly: true });
    const row = db.prepare('SELECT name, access_list_id FROM services WHERE id = ?').get('svc-1');
    db.close();
    assert.deepEqual(row, { name: 'grafana', access_list_id: null });
  });
});
