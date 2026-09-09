// One-off helper: apply db/schema.sql against DATABASE_URL. Run with:
//   node db/apply-schema.mjs
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(sql);
  console.log("Schema applied successfully.");
} finally {
  await client.end();
}
