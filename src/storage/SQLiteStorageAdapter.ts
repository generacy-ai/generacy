/**
 * SQLite Storage Adapter
 *
 * SQLite implementation using better-sqlite3 for persistent workflow storage.
 */

import Database from 'better-sqlite3';
import type { StorageAdapter } from '../types/StorageAdapter.js';
import type { WorkflowState, WorkflowFilter, WorkflowStatus } from '../types/WorkflowState.js';

/**
 * Configuration options for SQLite storage adapter.
 */
export interface SQLiteStorageOptions {
  /** Database file path. Use ':memory:' for in-memory database. */
  filename?: string;

  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * SQLite storage adapter for workflow state.
 * Uses better-sqlite3 for synchronous, high-performance SQLite access.
 */
export class SQLiteStorageAdapter implements StorageAdapter {
  private db: Database.Database | null = null;
  private readonly filename: string;
  private readonly verbose: boolean;

  constructor(options: SQLiteStorageOptions = {}) {
    this.filename = options.filename ?? ':memory:';
    this.verbose = options.verbose ?? false;
  }

  async initialize(): Promise<void> {
    this.db = new Database(this.filename, {
      verbose: this.verbose ? console.log : undefined,
    });

    // Enable WAL mode for better concurrent access
    this.db.pragma('journal_mode = WAL');

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        definition_name TEXT NOT NULL,
        definition_version TEXT NOT NULL,
        definition TEXT NOT NULL,
        status TEXT NOT NULL,
        current_step_id TEXT,
        context TEXT NOT NULL,
        step_results TEXT NOT NULL,
        step_attempts TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
      CREATE INDEX IF NOT EXISTS idx_workflows_definition ON workflows(definition_name, definition_version);
      CREATE INDEX IF NOT EXISTS idx_workflows_created ON workflows(created_at);
    `);
  }

  async shutdown(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async create(state: WorkflowState): Promise<void> {
    this.ensureInitialized();

    const exists = await this.exists(state.id);
    if (exists) {
      throw new Error(`Workflow with ID ${state.id} already exists`);
    }

    const stmt = this.db!.prepare(`
      INSERT INTO workflows (
        id, definition_name, definition_version, definition,
        status, current_step_id, context, step_results, step_attempts,
        error, created_at, updated_at, started_at, completed_at
      ) VALUES (
        @id, @definitionName, @definitionVersion, @definition,
        @status, @currentStepId, @context, @stepResults, @stepAttempts,
        @error, @createdAt, @updatedAt, @startedAt, @completedAt
      )
    `);

    stmt.run(this.serializeState(state));
  }

  async update(state: WorkflowState): Promise<void> {
    this.ensureInitialized();

    const exists = await this.exists(state.id);
    if (!exists) {
      throw new Error(`Workflow with ID ${state.id} does not exist`);
    }

    const stmt = this.db!.prepare(`
      UPDATE workflows SET
        definition_name = @definitionName,
        definition_version = @definitionVersion,
        definition = @definition,
        status = @status,
        current_step_id = @currentStepId,
        context = @context,
        step_results = @stepResults,
        step_attempts = @stepAttempts,
        error = @error,
        updated_at = @updatedAt,
        started_at = @startedAt,
        completed_at = @completedAt
      WHERE id = @id
    `);

    stmt.run(this.serializeState(state));
  }

  async get(id: string): Promise<WorkflowState | undefined> {
    this.ensureInitialized();

    const stmt = this.db!.prepare('SELECT * FROM workflows WHERE id = ?');
    const row = stmt.get(id) as SQLiteRow | undefined;

    return row ? this.deserializeState(row) : undefined;
  }

  async list(filter?: WorkflowFilter): Promise<WorkflowState[]> {
    this.ensureInitialized();

    const { sql, params } = this.buildListQuery(filter);
    const stmt = this.db!.prepare(sql);
    const rows = stmt.all(...params) as SQLiteRow[];

    return rows.map((row) => this.deserializeState(row));
  }

  async delete(id: string): Promise<boolean> {
    this.ensureInitialized();

    const stmt = this.db!.prepare('DELETE FROM workflows WHERE id = ?');
    const result = stmt.run(id);

    return result.changes > 0;
  }

  async exists(id: string): Promise<boolean> {
    this.ensureInitialized();

    const stmt = this.db!.prepare('SELECT 1 FROM workflows WHERE id = ?');
    const row = stmt.get(id);

    return row !== undefined;
  }

  async count(filter?: WorkflowFilter): Promise<number> {
    this.ensureInitialized();

    const { sql, params } = this.buildCountQuery(filter);
    const stmt = this.db!.prepare(sql);
    const row = stmt.get(...params) as { count: number };

    return row.count;
  }

  private ensureInitialized(): void {
    if (!this.db) {
      throw new Error('Storage adapter not initialized. Call initialize() first.');
    }
  }

  private serializeState(state: WorkflowState): SerializedWorkflow {
    return {
      id: state.id,
      definitionName: state.definitionName,
      definitionVersion: state.definitionVersion,
      definition: JSON.stringify(state.definition),
      status: state.status,
      currentStepId: state.currentStepId,
      context: JSON.stringify(state.context),
      stepResults: JSON.stringify(state.stepResults),
      stepAttempts: JSON.stringify(state.stepAttempts),
      error: state.error ? JSON.stringify(state.error) : null,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      startedAt: state.startedAt ?? null,
      completedAt: state.completedAt ?? null,
    };
  }

  private deserializeState(row: SQLiteRow): WorkflowState {
    // SQLite returns snake_case column names
    const definitionName = row.definition_name;
    const definitionVersion = row.definition_version;
    const currentStepId = row.current_step_id;
    const stepResults = row.step_results;
    const stepAttempts = row.step_attempts;
    const createdAt = row.created_at;
    const updatedAt = row.updated_at;
    const startedAt = row.started_at;
    const completedAt = row.completed_at;

    return {
      id: row.id,
      definitionName,
      definitionVersion,
      definition: JSON.parse(row.definition),
      status: row.status as WorkflowStatus,
      currentStepId: currentStepId ?? null,
      context: JSON.parse(row.context),
      stepResults: JSON.parse(stepResults),
      stepAttempts: JSON.parse(stepAttempts),
      error: row.error ? JSON.parse(row.error) : undefined,
      createdAt,
      updatedAt,
      startedAt: startedAt ?? undefined,
      completedAt: completedAt ?? undefined,
    };
  }

  private buildListQuery(filter?: WorkflowFilter): { sql: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      const placeholders = statuses.map(() => '?').join(', ');
      conditions.push(`status IN (${placeholders})`);
      params.push(...statuses);
    }

    if (filter?.definitionName) {
      conditions.push('definition_name = ?');
      params.push(filter.definitionName);
    }

    if (filter?.definitionVersion) {
      conditions.push('definition_version = ?');
      params.push(filter.definitionVersion);
    }

    if (filter?.createdAfter) {
      conditions.push('created_at >= ?');
      params.push(filter.createdAfter);
    }

    if (filter?.createdBefore) {
      conditions.push('created_at <= ?');
      params.push(filter.createdBefore);
    }

    let sql = 'SELECT * FROM workflows';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY created_at DESC';

    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }

    if (filter?.offset) {
      sql += ' OFFSET ?';
      params.push(filter.offset);
    }

    return { sql, params };
  }

  private buildCountQuery(filter?: WorkflowFilter): { sql: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      const placeholders = statuses.map(() => '?').join(', ');
      conditions.push(`status IN (${placeholders})`);
      params.push(...statuses);
    }

    if (filter?.definitionName) {
      conditions.push('definition_name = ?');
      params.push(filter.definitionName);
    }

    if (filter?.definitionVersion) {
      conditions.push('definition_version = ?');
      params.push(filter.definitionVersion);
    }

    if (filter?.createdAfter) {
      conditions.push('created_at >= ?');
      params.push(filter.createdAfter);
    }

    if (filter?.createdBefore) {
      conditions.push('created_at <= ?');
      params.push(filter.createdBefore);
    }

    let sql = 'SELECT COUNT(*) as count FROM workflows';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    return { sql, params };
  }
}

/**
 * Row format for inserting/updating (camelCase for binding params)
 */
interface SerializedWorkflow {
  id: string;
  definitionName: string;
  definitionVersion: string;
  definition: string;
  status: string;
  currentStepId: string | null;
  context: string;
  stepResults: string;
  stepAttempts: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * Row format returned from SQLite queries (snake_case column names)
 */
interface SQLiteRow {
  id: string;
  definition_name: string;
  definition_version: string;
  definition: string;
  status: string;
  current_step_id: string | null;
  context: string;
  step_results: string;
  step_attempts: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}
