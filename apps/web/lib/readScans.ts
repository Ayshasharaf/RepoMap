import fs from "fs";
import path from "path";
import { snapshotOf } from "./diff";
import type { ScanResult } from "./types";

/** `scans/` at the workspace root. Next runs with cwd `apps/web`. */
export function scansDirectory(): string {
  return path.resolve(process.cwd(), "../../scans");
}

/**
 * Reads every *.json file from the `scans/` directory at the workspace root.
 * Returns an empty array when the directory is absent or empty.
 */
export async function readScans(): Promise<ScanResult[]> {
  const scansDir = scansDirectory();
  let files: string[];
  try {
    files = fs.readdirSync(scansDir).filter((f) => f.endsWith(".json") && !f.endsWith(".prev"));
  } catch {
    return [];
  }

  const results: ScanResult[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(scansDir, file), "utf8");
      const scan = JSON.parse(raw) as ScanResult;
      const previous = readPrevious(path.join(scansDir, `${file}.prev`));
      if (previous) scan.previous = previous;
      results.push(scan);
    } catch {
      // skip malformed files
    }
  }

  // sort by service name
  results.sort((a, b) => a.service.localeCompare(b.service));
  return results;
}

function readPrevious(filePath: string) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as ScanResult;
    if (!raw?.counts || !Array.isArray(raw.findings)) return undefined;
    return snapshotOf(raw);
  } catch {
    return undefined;
  }
}
