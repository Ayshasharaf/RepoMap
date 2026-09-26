import { readScans } from "@/lib/readScans";
import Dashboard from "@/components/Dashboard";

export default async function Home() {
  const initialScans = await readScans();
  return <Dashboard initialScans={initialScans} />;
}
