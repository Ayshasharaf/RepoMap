import fs from "fs";
import path from "path";
import type { ScanResult } from "./types";

/**
 * Reads every *.json file from the `scans/` directory at the workspace root.
 * Returns an empty array when the directory is absent or empty.
 */
export async function readScans(): Promise<ScanResult[]> {
  const scansDir = path.resolve(process.cwd(), "../../scans");
  let files: string[];
  try {
    files = fs.readdirSync(scansDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const results: ScanResult[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(scansDir, file), "utf8");
      results.push(JSON.parse(raw) as ScanResult);
    } catch {
      // skip malformed files
    }
  }

  // sort by service name
  results.sort((a, b) => a.service.localeCompare(b.service));
  return results;
}
