// Minimal .env loader (no dependency). Real environment variables take precedence.
import fs from "node:fs";

const file = new URL("../.env", import.meta.url);
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
