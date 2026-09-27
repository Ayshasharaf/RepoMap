import Dashboard from "@/components/Dashboard";
import { readScans } from "@/lib/readScans";

export default async function ScanPage({ params }: { params: Promise<{ service: string }> }) {
  const { service } = await params;
  const name = decodeURIComponent(service);
  const scans = await readScans();
  const match = scans.find((scan) => scan.service === name);
  if (!match) {
    return (
      <section className="plaque">
        <div className="plaque-inner">
          <div className="kicker">Scan</div>
          <h1>No saved scan for {name}.</h1>
          <p>Map the repo from the home page first. This link only opens a scan stored on this server.</p>
          <p><a className="link-btn" href="/">Back to RepoMap</a></p>
        </div>
      </section>
    );
  }
  const ordered = [match, ...scans.filter((scan) => scan.service !== match.service)];
  return <Dashboard initialScans={ordered} />;
}
