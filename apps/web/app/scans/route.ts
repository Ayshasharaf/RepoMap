import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { scansDirectory } from "../../lib/readScans";

export const dynamic = "force-dynamic";

function safeScanName(service: string): string | null {
  const trimmed = service.trim();
  if (!trimmed || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    return null;
  }
  // Match scanner persistence: path separators become underscores.
  const safe = trimmed.replace(/\//g, "_").replace(/\\/g, "_");
  if (!safe || safe !== path.basename(safe)) return null;
  return safe;
}

export async function DELETE(req: NextRequest) {
  const service = req.nextUrl.searchParams.get("service") ?? "";
  const safe = safeScanName(service);
  if (!safe) {
    return NextResponse.json({ error: "Missing or invalid service" }, { status: 400 });
  }

  const dir = scansDirectory();
  const file = path.join(dir, `${safe}.json`);
  const previous = path.join(dir, `${safe}.json.prev`);

  if (!file.startsWith(dir + path.sep) && file !== dir) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  let removed = false;
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      removed = true;
    }
    if (fs.existsSync(previous)) {
      fs.unlinkSync(previous);
      removed = true;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Could not remove scan: ${msg}` }, { status: 500 });
  }

  if (!removed) {
    return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, service: safe });
}
