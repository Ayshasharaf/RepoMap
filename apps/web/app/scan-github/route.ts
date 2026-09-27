import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const BACKEND = process.env.SCANNER_URL ?? "http://localhost:8000";

if (!process.env.SCANNER_URL) {
  console.warn(
    "[repomap] SCANNER_URL is not set — defaulting to http://localhost:8000. " +
    "Set SCANNER_URL in your environment (e.g. apps/web/.env.local) to point at the scanner."
  );
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const payload = JSON.stringify(body);
  let res: Response;
  try {
    res = await fetch(`${BACKEND}/scan-github/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(120_000),
    });
    // The scanner process that was already running does not have this route.
    if (res.status === 404) {
      res = await fetch(`${BACKEND}/scan-github`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(90_000),
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Scanner unreachable: ${msg}` }, { status: 502 });
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !res.body || contentType.includes("application/json")) {
    const data = await res.json().catch(() => ({ error: `Error ${res.status}` }));
    return NextResponse.json(data, { status: res.status });
  }

  return new Response(res.body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
