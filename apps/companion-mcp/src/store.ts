import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { Character } from "./config.js";

export type Scene = {
  sessionId: string;
  revision: number;
  character: Character;
  mode: "avatar" | "role";
  expression: string;
  sceneId: string;
  outfit: string;
  action: string;
  line: string;
};
export type Job = {
  id: string;
  sessionId: string;
  revision: number;
  status: "queued" | "running" | "succeeded" | "failed" | "interrupted";
  request: Record<string, unknown>;
  asset?: string;
  error?: string;
  createdAt: string;
};
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "assets"), { recursive: true });
    this.db = new DatabaseSync(join(dir, "companion.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(owner TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner,key));
      CREATE TABLE IF NOT EXISTS scenes(session_id TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(session_id,revision));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, day TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  once<T>(owner: string, key: string, input: unknown, fn: () => T): T {
    return this.transaction(() => {
      const old = this.db
        .prepare("SELECT * FROM events WHERE owner=? AND key=?")
        .get(owner, key);
      const hash = fingerprint(input);
      if (old) {
        if (old.hash !== hash)
          throw new Error("event_id already used with different arguments");
        return JSON.parse(old.value as string) as T;
      }
      const result = fn();
      this.db
        .prepare("INSERT INTO events VALUES(?,?,?,?)")
        .run(owner, key, hash, JSON.stringify(result));
      return result;
    });
  }
  open(
    owner: string,
    eventId: string,
    character: Character,
    mode: "avatar" | "role",
  ): Scene {
    return this.once(
      owner,
      `open:${eventId}`,
      { character: character.id, mode },
      () => {
        const s: Scene = {
          sessionId: randomUUID(),
          revision: 0,
          character,
          mode,
          expression: character.defaultExpression,
          sceneId: character.defaultScene,
          outfit: character.defaultOutfit,
          action: "",
          line: "",
        };
        this.db
          .prepare("INSERT INTO sessions VALUES(?,?,?)")
          .run(s.sessionId, owner, JSON.stringify(s));
        this.saveScene(s);
        return s;
      },
    );
  }
  scene(owner: string, sessionId: string, revision?: number): Scene {
    const row = this.db
      .prepare("SELECT value FROM sessions WHERE id=? AND owner=?")
      .get(sessionId, owner);
    if (!row) throw new Error("Session not found");
    if (revision === undefined) return JSON.parse(row.value as string) as Scene;
    const historical = this.db
      .prepare("SELECT value FROM scenes WHERE session_id=? AND revision=?")
      .get(sessionId, revision);
    if (!historical) throw new Error("Scene revision not found");
    return JSON.parse(historical.value as string) as Scene;
  }
  saveScene(s: Scene) {
    this.db
      .prepare("INSERT INTO scenes VALUES(?,?,?)")
      .run(s.sessionId, s.revision, JSON.stringify(s));
  }
  perform(
    owner: string,
    input: {
      sessionId: string;
      eventId: string;
      expectedRevision: number;
      expression?: string;
      sceneId?: string;
      outfit?: string;
      action?: string;
      line: string;
    },
  ): Scene {
    return this.once(
      owner,
      `turn:${input.sessionId}:${input.eventId}`,
      input,
      () => {
        const s = this.scene(owner, input.sessionId);
        if (s.revision !== input.expectedRevision)
          throw new Error(
            `Revision conflict: current revision is ${s.revision}; read scene and retry with a new event_id`,
          );
        for (const [field, collection] of [
          ["expression", "expressions"],
          ["sceneId", "scenes"],
          ["outfit", "outfits"],
        ] as const) {
          const value = input[field];
          if (value !== undefined) {
            if (!Object.hasOwn(s.character[collection], value))
              throw new Error(`Unknown ${field}: ${value}`);
            s[field] = value;
          }
        }
        s.action = input.action ?? s.action;
        s.line = input.line;
        s.revision++;
        this.db
          .prepare("UPDATE sessions SET value=? WHERE id=?")
          .run(JSON.stringify(s), s.sessionId);
        this.saveScene(s);
        return s;
      },
    );
  }
  enqueue(
    owner: string,
    eventId: string,
    s: Scene,
    request: Record<string, unknown>,
    dailyLimit: number,
  ): Job {
    return this.once(
      owner,
      `generate:${s.sessionId}:${eventId}`,
      { sessionId: s.sessionId, revision: s.revision, request },
      () => {
        const day = new Date().toISOString().slice(0, 10);
        const used = this.db
          .prepare("SELECT count(*) AS n FROM jobs WHERE day=?")
          .get(day)!.n as number;
        if (used >= dailyLimit)
          throw new Error(
            "Daily generation limit reached (failed/uncertain requests also count)",
          );
        const job: Job = {
          id: randomUUID(),
          sessionId: s.sessionId,
          revision: s.revision,
          status: "queued",
          request,
          createdAt: new Date().toISOString(),
        };
        this.db
          .prepare("INSERT INTO jobs VALUES(?,?,?,?)")
          .run(job.id, owner, day, JSON.stringify(job));
        return job;
      },
    );
  }
  job(owner: string, id: string): Job {
    const row = this.db
      .prepare("SELECT value FROM jobs WHERE id=? AND owner=?")
      .get(id, owner);
    if (!row) throw new Error("Job not found");
    return JSON.parse(row.value as string);
  }
  jobs(): Job[] {
    return this.db
      .prepare("SELECT value FROM jobs ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(r.value as string) as Job);
  }
  updateJob(j: Job) {
    this.db
      .prepare("UPDATE jobs SET value=? WHERE id=?")
      .run(JSON.stringify(j), j.id);
  }
  setting(key: string): unknown {
    const r = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return r ? JSON.parse(r.value as string) : undefined;
  }
  setSetting(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
      .run(key, JSON.stringify(value));
  }
  close() {
    this.db.close();
  }
}
