import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA } from "./schema";

export type Db = Database.Database;

const DEFAULT_PATH = process.env.VERCEL ? "/tmp/falcon.db" : "falcon.db";
const DEMO_SEED = join(process.cwd(), "data", "falcon-demo.db");

/**
 * On Vercel the project filesystem is read-only, so copy the bundled demo DB to /tmp
 * on first use. Local runs keep using falcon.db and the normal ingest workflow.
 */
function bootstrapDemoDb(path: string) {
  if (!process.env.VERCEL || path === ":memory:" || existsSync(path)) return;
  if (!existsSync(DEMO_SEED)) return;
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(DEMO_SEED, path);
}

export function openDb(path = process.env.FALCON_DB ?? DEFAULT_PATH): Db {
  bootstrapDemoDb(path);
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
