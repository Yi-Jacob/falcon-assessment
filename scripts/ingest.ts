import { join } from "node:path";
import { openDb } from "../src/lib/db/db";
import { DEFAULT_FILES, ingestFiles, type SourceType } from "../src/lib/ingest/ingest";
import { runReconciliation } from "../src/lib/reconciliation/run";

const dir = process.argv[2] ?? "data";
const db = openDb();
const files = (Object.keys(DEFAULT_FILES) as SourceType[]).map((type) => ({ type, path: join(dir, DEFAULT_FILES[type]) }));
for (const s of ingestFiles(db, files)) console.log(`${s.status.padEnd(18)} ${s.file} rows=${s.rows} sha256=${s.sha256.slice(0, 12)}…`);
const { runId, results, reused } = runReconciliation(db);
console.log(`reconciliation run ${runId} (${reused ? "reused: inputs unchanged" : "new"}), ${results.length} result rows`);
