import fs from "node:fs";
import path from "node:path";

/** Load .env.local (then .env) into process.env for the command-line scripts. Next.js does this itself for the app. */
export function loadEnvFiles(dir = process.cwd()): void {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

loadEnvFiles();
