import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DetectedField } from '../intelligence/types.js';
import type {
  AnswerCategory,
  AnswerMatchResult,
  ApplicationHistoryEntry,
  CreateApplicationHistoryInput,
  SavedAnswer,
  UpsertAnswerInput,
  UserProfile,
} from './types.js';

const require = createRequire(import.meta.url);

interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function openSqliteDatabase(dbPath: string): SqliteDatabase {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Try better-sqlite3 first if native binary is built; fall back to Node 24 built-in node:sqlite
  try {
    const BetterSqlite3 = require('better-sqlite3');
    const db = new BetterSqlite3(dbPath) as SqliteDatabase;
    db.exec('PRAGMA journal_mode = WAL; PRAGMA cache_size = -2000;');
    return db;
  } catch {
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (filename: string) => SqliteDatabase;
    };
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA cache_size = -2000;');
    return db;
  }
}

const DEFAULT_PROFILE: UserProfile = {
  fullName: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  location: '',
  linkedinUrl: '',
  githubUrl: '',
  portfolioUrl: '',
  resumePath: '',
  yearsOfExperience: '',
  workAuthorization: '',
  sponsorshipRequired: '',
  salaryExpectation: '',
  noticePeriod: '',
  summary: '',
};

/**
 * AnswerMemory: Manages persistent SQLite storage for reusable user answers,
 * user profile fields, and application history.
 *
 * Safety invariant: Never invents personal information. When confidence is insufficient
 * or a profile field is blank, marks the field as needing human clarification.
 */
export class AnswerMemory {
  private readonly db: SqliteDatabase;

  constructor(dbPath = ':memory:') {
    this.db = openSqliteDatabase(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_profile (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS answer_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question_key TEXT NOT NULL UNIQUE,
        raw_question TEXT NOT NULL,
        answer TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'custom',
        aliases TEXT NOT NULL DEFAULT '[]',
        usage_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS application_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company TEXT NOT NULL,
        role_title TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        filled_fields_count INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '',
        applied_at TEXT NOT NULL
      );
    `);
  }

  /**
   * Normalizes a question/label string into a canonical lookup key.
   */
  public normalizeQuestionKey(raw: string): string {
    return raw
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Retrieves the complete user profile.
   */
  public getProfile(): UserProfile {
    const rows = this.db
      .prepare('SELECT key, value FROM user_profile')
      .all() as Array<{ key: string; value: string }>;

    const profile: UserProfile = { ...DEFAULT_PROFILE };
    for (const row of rows) {
      if (row.key in profile) {
        profile[row.key as keyof UserProfile] = row.value;
      }
    }
    return profile;
  }

  /**
   * Updates user profile fields in SQLite.
   */
  public updateProfile(partial: Partial<UserProfile>): UserProfile {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO user_profile (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);

    for (const [key, value] of Object.entries(partial)) {
      if (key in DEFAULT_PROFILE && typeof value === 'string') {
        stmt.run(key, value.trim(), now);
      }
    }

    return this.getProfile();
  }

  /**
   * Saves or updates a reusable question-to-answer mapping.
   */
  public upsertAnswer(input: UpsertAnswerInput): SavedAnswer {
    const questionKey = this.normalizeQuestionKey(input.rawQuestion);
    if (!questionKey) {
      throw new Error('Question text cannot be empty');
    }

    const now = new Date().toISOString();
    const category: AnswerCategory = input.category ?? 'custom';
    const aliasesJson = JSON.stringify(
      (input.aliases ?? []).map((a) => this.normalizeQuestionKey(a)).filter(Boolean)
    );

    this.db
      .prepare(
        `
      INSERT INTO answer_memory (question_key, raw_question, answer, category, aliases, usage_count, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(question_key) DO UPDATE SET
        raw_question = excluded.raw_question,
        answer = excluded.answer,
        category = excluded.category,
        aliases = excluded.aliases,
        updated_at = excluded.updated_at
    `
      )
      .run(questionKey, input.rawQuestion.trim(), input.answer, category, aliasesJson, now);

    const row = this.db
      .prepare('SELECT * FROM answer_memory WHERE question_key = ?')
      .get(questionKey) as Record<string, unknown>;

    return this.mapSavedAnswerRow(row);
  }

  /**
   * Lists all saved answers in memory.
   */
  public listAnswers(): SavedAnswer[] {
    const rows = this.db
      .prepare('SELECT * FROM answer_memory ORDER BY updated_at DESC, id DESC')
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => this.mapSavedAnswerRow(r));
  }

  /**
   * Deletes a saved answer by ID.
   */
  public deleteAnswer(id: number): boolean {
    const res = this.db.prepare('DELETE FROM answer_memory WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  /**
   * Increments usage count for a matched question key.
   */
  public recordAnswerUsage(questionKey: string): void {
    this.db
      .prepare('UPDATE answer_memory SET usage_count = usage_count + 1 WHERE question_key = ?')
      .run(questionKey);
  }

  /**
   * Matches a detected form field to an approved answer fromAnswer Memory or UserProfile.
   * Never invents data: returns needsClarification=true when confidence is insufficient.
   */
  public matchField(field: DetectedField): AnswerMatchResult {
    const candidates = [field.label, field.ariaLabel, field.placeholder, field.name, field.elementId]
      .map((s) => this.normalizeQuestionKey(s || ''))
      .filter(Boolean);

    const allSaved = this.listAnswers();

    // 1. Exact match on saved answer questionKey or alias
    for (const candidate of candidates) {
      for (const saved of allSaved) {
        if (saved.questionKey === candidate || saved.aliases.includes(candidate)) {
          if (saved.answer.trim() !== '') {
            return {
              answer: saved.answer,
              confidence: 0.98,
              matchedKey: saved.questionKey,
              needsClarification: false,
            };
          }
        }
      }
    }

    // 2. Substring/keyword match on saved answers (for multi-word questions)
    for (const candidate of candidates) {
      if (candidate.length < 4) continue;
      for (const saved of allSaved) {
        if (
          saved.questionKey.length >= 4 &&
          (candidate.includes(saved.questionKey) || saved.questionKey.includes(candidate))
        ) {
          if (saved.answer.trim() !== '') {
            return {
              answer: saved.answer,
              confidence: 0.82,
              matchedKey: saved.questionKey,
              needsClarification: false,
            };
          }
        }
      }
    }

    // 3. Match against UserProfile canonical fields
    const profile = this.getProfile();
    const combinedText = candidates.join(' ');

    if (field.type === 'file') {
      if (/\b(resume|cv|curriculum vitae)\b/.test(combinedText) && profile.resumePath) {
        return {
          answer: profile.resumePath,
          confidence: 0.95,
          matchedKey: 'profile.resumePath',
          needsClarification: false,
        };
      }
      return {
        answer: null,
        confidence: 0,
        matchedKey: null,
        needsClarification: true,
      };
    }

    const profileMatchers: Array<{ pattern: RegExp; key: keyof UserProfile }> = [
      { pattern: /\b(first name|given name|fname)\b/, key: 'firstName' },
      { pattern: /\b(last name|surname|family name|lname)\b/, key: 'lastName' },
      { pattern: /\b(full name|your name|legal name|candidate name)\b|^name$/, key: 'fullName' },
      { pattern: /\b(email|e mail)\b/, key: 'email' },
      { pattern: /\b(phone|mobile|telephone|cell)\b/, key: 'phone' },
      { pattern: /\b(linkedin)\b/, key: 'linkedinUrl' },
      { pattern: /\b(github)\b/, key: 'githubUrl' },
      { pattern: /\b(portfolio|personal website|website|blog)\b/, key: 'portfolioUrl' },
      { pattern: /\b(location|city|current city|address)\b/, key: 'location' },
      { pattern: /\b(years of experience|total experience|experience years)\b/, key: 'yearsOfExperience' },
      { pattern: /\b(authorized to work|work authorization|legally authorized)\b/, key: 'workAuthorization' },
      { pattern: /\b(sponsorship|visa sponsorship|require sponsorship)\b/, key: 'sponsorshipRequired' },
      { pattern: /\b(salary|compensation|expected pay|desired pay)\b/, key: 'salaryExpectation' },
      { pattern: /\b(notice period|start date|earliest start)\b/, key: 'noticePeriod' },
      { pattern: /\b(summary|cover letter|bio|about you)\b/, key: 'summary' },
    ];

    for (const matcher of profileMatchers) {
      if (matcher.pattern.test(combinedText)) {
        const value = profile[matcher.key]?.trim();
        if (value) {
          return {
            answer: value,
            confidence: 0.9,
            matchedKey: `profile.${matcher.key}`,
            needsClarification: false,
          };
        }
      }
    }

    // Insufficient confidence or missing profile value -> ask user for clarification
    return {
      answer: null,
      confidence: 0,
      matchedKey: null,
      needsClarification: true,
    };
  }

  /**
   * Annotates an array of detected fields with suggested answers from memory.
   */
  public enrichDetectedFields(fields: DetectedField[]): DetectedField[] {
    return fields.map((field) => {
      const match = this.matchField(field);
      return {
        ...field,
        suggestedAnswer: match.answer,
        confidence: match.confidence,
        matchedQuestionKey: match.matchedKey,
        needsClarification: match.needsClarification,
      };
    });
  }

  /**
   * Logs an application history entry (Milestone 7).
   */
  public addApplicationHistory(input: CreateApplicationHistoryInput): ApplicationHistoryEntry {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `
      INSERT INTO application_history (company, role_title, url, status, filled_fields_count, notes, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        input.company.trim() || 'Unknown Company',
        input.roleTitle.trim() || 'Unknown Role',
        input.url.trim(),
        input.status,
        input.filledFieldsCount ?? 0,
        input.notes?.trim() ?? '',
        now
      );

    const id = Number(res.lastInsertRowid);
    const row = this.db
      .prepare('SELECT * FROM application_history WHERE id = ?')
      .get(id) as Record<string, unknown>;

    return this.mapHistoryRow(row);
  }

  /**
   * Retrieves all application history entries, newest first.
   */
  public listApplicationHistory(): ApplicationHistoryEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM application_history ORDER BY applied_at DESC, id DESC')
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => this.mapHistoryRow(r));
  }

  /**
   * Closes the SQLite database connection cleanly.
   */
  public close(): void {
    this.db.close();
  }

  private mapSavedAnswerRow(row: Record<string, unknown>): SavedAnswer {
    let aliases: string[] = [];
    try {
      aliases = JSON.parse(String(row.aliases || '[]'));
    } catch {
      aliases = [];
    }

    return {
      id: Number(row.id),
      questionKey: String(row.question_key),
      rawQuestion: String(row.raw_question),
      answer: String(row.answer),
      category: (row.category as AnswerCategory) || 'custom',
      aliases,
      usageCount: Number(row.usage_count ?? 0),
      updatedAt: String(row.updated_at),
    };
  }

  private mapHistoryRow(row: Record<string, unknown>): ApplicationHistoryEntry {
    return {
      id: Number(row.id),
      company: String(row.company),
      roleTitle: String(row.role_title),
      url: String(row.url),
      status: row.status as ApplicationHistoryEntry['status'],
      filledFieldsCount: Number(row.filled_fields_count ?? 0),
      notes: String(row.notes ?? ''),
      appliedAt: String(row.applied_at),
    };
  }
}
