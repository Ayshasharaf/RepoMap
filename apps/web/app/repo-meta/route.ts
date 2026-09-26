import { NextRequest, NextResponse } from "next/server";

const REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url")?.trim() ?? "";
  const match = url.match(REPO);
  if (!match) {
    return NextResponse.json({ error: "Only a public https://github.com/owner/repo URL is accepted" }, { status: 400 });
  }
  const [owner, repo] = [match[1], match[2]];
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "repomap",
  };
  try {
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!repoRes.ok) {
      return NextResponse.json({ stars: null, contributors: null, openIssues: null, description: "", license: "", language: "", pushedAt: "" });
    }
    const body = await repoRes.json();
    let contributors: number | null = null;
    const people = await fetch(`https://api.github.com/repos/${owner}/${repo}/contributors?per_page=1&anon=1`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (people.ok) {
      const link = people.headers.get("link") ?? "";
      const last = link.match(/[&?]page=(\d+)>;\s*rel="last"/);
      if (last) contributors = Number(last[1]);
      else {
        const list = await people.json();
        contributors = Array.isArray(list) ? list.length : null;
      }
    }
    return NextResponse.json({
      stars: typeof body.stargazers_count === "number" ? body.stargazers_count : null,
      contributors,
      openIssues: typeof body.open_issues_count === "number" ? body.open_issues_count : null,
      description: body.description ?? "",
      license: body.license?.spdx_id && body.license.spdx_id !== "NOASSERTION" ? body.license.spdx_id : "",
      language: body.language ?? "",
      pushedAt: typeof body.pushed_at === "string" ? body.pushed_at.slice(0, 10) : "",
    });
  } catch {
    return NextResponse.json({ stars: null, contributors: null, openIssues: null, description: "", license: "", language: "", pushedAt: "" });
  }
}
