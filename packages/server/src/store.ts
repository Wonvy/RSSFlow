import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { DetailData, Recipe } from '@rssflow/core';

export interface StoredRecipe {
  id: string;
  recipe: Recipe;
  isPublic: boolean;
  createdAt: number;
  updatedAt: number;
  lastMode?: 'api' | 'static' | 'render';
  lastCount?: number;
  lastError?: string;
  lastRunAt?: number;
}

interface Row {
  id: string;
  json: string;
  public: number;
  created_at: number;
  updated_at: number;
  last_mode: string | null;
  last_count: number | null;
  last_error: string | null;
  last_run_at: number | null;
}

const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';
function newId(len = 10): string {
  const bytes = randomBytes(len);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

function fromRow(r: Row): StoredRecipe {
  return {
    id: r.id,
    recipe: JSON.parse(r.json) as Recipe,
    isPublic: r.public === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastMode: (r.last_mode as StoredRecipe['lastMode']) ?? undefined,
    lastCount: r.last_count ?? undefined,
    lastError: r.last_error ?? undefined,
    lastRunAt: r.last_run_at ?? undefined,
  };
}

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS recipes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        json TEXT NOT NULL,
        public INTEGER NOT NULL DEFAULT 1,
        edit_token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_mode TEXT,
        last_count INTEGER,
        last_error TEXT,
        last_run_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_recipes_public ON recipes(public, updated_at);
      CREATE TABLE IF NOT EXISTS details (
        url TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        json TEXT
      );
      CREATE TABLE IF NOT EXISTS ai_summaries (
        url TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen (
        recipe_id TEXT NOT NULL,
        key TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        PRIMARY KEY (recipe_id, key)
      );
    `);
  }

  create(recipe: Recipe, isPublic: boolean): { id: string; editToken: string } {
    const id = newId();
    const editToken = randomBytes(18).toString('base64url');
    const now = Date.now();
    this.db
      .prepare('INSERT INTO recipes (id, name, url, json, public, edit_token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, recipe.name, recipe.url, JSON.stringify(recipe), isPublic ? 1 : 0, hashToken(editToken), now, now);
    return { id, editToken };
  }

  get(id: string): StoredRecipe | undefined {
    const r = this.db.prepare('SELECT * FROM recipes WHERE id = ?').get(id) as Row | undefined;
    return r ? fromRow(r) : undefined;
  }

  checkToken(id: string, token: string | undefined): boolean {
    if (!token) return false;
    const r = this.db.prepare('SELECT edit_token_hash FROM recipes WHERE id = ?').get(id) as { edit_token_hash: string } | undefined;
    return !!r && r.edit_token_hash === hashToken(token);
  }

  update(id: string, recipe: Recipe, isPublic: boolean): void {
    this.db
      .prepare('UPDATE recipes SET name = ?, url = ?, json = ?, public = ?, updated_at = ?, last_mode = NULL WHERE id = ?')
      .run(recipe.name, recipe.url, JSON.stringify(recipe), isPublic ? 1 : 0, Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM seen WHERE recipe_id = ?').run(id);
  }

  /**
   * 记录并返回每个条目第一次被看到的时间。
   * 同一批新条目按页面顺序依次早 1 秒，保证阅读器里的顺序和网页一致（排在前面的更新）。
   */
  firstSeen(recipeId: string, keys: string[], now = Date.now()): Map<string, number> {
    const insert = this.db.prepare('INSERT OR IGNORE INTO seen (recipe_id, key, first_seen) VALUES (?, ?, ?)');
    const select = this.db.prepare('SELECT first_seen FROM seen WHERE recipe_id = ? AND key = ?');
    const out = new Map<string, number>();
    this.db.exec('BEGIN');
    try {
      keys.forEach((k, i) => {
        insert.run(recipeId, k, now - i * 1000);
        const row = select.get(recipeId, k) as { first_seen: number } | undefined;
        if (row) out.set(k, row.first_seen);
      });
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return out;
  }

  recordRun(id: string, r: { mode?: 'api' | 'static' | 'render'; count?: number; error?: string }): void {
    this.db
      .prepare('UPDATE recipes SET last_mode = COALESCE(?, last_mode), last_count = ?, last_error = ?, last_run_at = ? WHERE id = ?')
      .run(r.mode ?? null, r.count ?? null, r.error ?? null, Date.now(), id);
  }

  listPublic(opts: { q?: string; limit?: number; offset?: number } = {}): StoredRecipe[] {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;
    const rows = opts.q
      ? (this.db
          .prepare("SELECT * FROM recipes WHERE public = 1 AND (name LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT ? OFFSET ?")
          .all(...Array(2).fill(`%${opts.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`), limit, offset) as unknown as Row[])
      : (this.db.prepare('SELECT * FROM recipes WHERE public = 1 ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset) as unknown as Row[]);
    return rows.map(fromRow);
  }

  /** 详情页缓存：status 为 ok / blocked / error */
  getDetails(urls: string[]): Map<string, { status: string; fetchedAt: number; data?: DetailData }> {
    const out = new Map<string, { status: string; fetchedAt: number; data?: DetailData }>();
    const stmt = this.db.prepare('SELECT status, fetched_at, json FROM details WHERE url = ?');
    for (const u of urls) {
      const r = stmt.get(u) as { status: string; fetched_at: number; json: string | null } | undefined;
      if (r) out.set(u, { status: r.status, fetchedAt: r.fetched_at, data: r.json ? (JSON.parse(r.json) as DetailData) : undefined });
    }
    return out;
  }

  saveDetail(url: string, status: 'ok' | 'blocked' | 'error', data?: DetailData): void {
    this.db
      .prepare('INSERT INTO details (url, status, fetched_at, json) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET status = excluded.status, fetched_at = excluded.fetched_at, json = excluded.json')
      .run(url, status, Date.now(), data ? JSON.stringify(data) : null);
  }

  getAiSummaries(urls: string[]): Map<string, string> {
    const out = new Map<string, string>();
    const stmt = this.db.prepare('SELECT summary FROM ai_summaries WHERE url = ?');
    for (const u of urls) {
      const r = stmt.get(u) as { summary: string } | undefined;
      if (r) out.set(u, r.summary);
    }
    return out;
  }

  saveAiSummary(url: string, model: string, summary: string): void {
    this.db
      .prepare('INSERT INTO ai_summaries (url, model, summary, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET model = excluded.model, summary = excluded.summary, created_at = excluded.created_at')
      .run(url, model, summary, Date.now());
  }

  close(): void {
    this.db.close();
  }
}
