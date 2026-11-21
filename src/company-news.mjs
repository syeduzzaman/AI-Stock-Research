import { fixtureDate, mode } from "./market.mjs";

const windowDays = 45;
const day = 86_400_000;

export async function companyNews(mcp, ticker, { dataMode = mode, now = new Date() } = {}) {
  const [releases, filings] = await Promise.allSettled([
    mcp.call("get_press_releases", { ticker }),
    mcp.call("get_recent_filings", { ticker })
  ]);
  const through = dataMode === "demo" ? new Date(fixtureDate + "T23:59:59.999Z") : now;
  const since = new Date(through.getTime() - (windowDays - 1) * day).toISOString().slice(0, 10);
  const items = [];
  if (releases.status === "fulfilled") {
    for (const release of releases.value.releases) {
      const recent = release.publishedAt.slice(0, 10) >= since && Date.parse(release.publishedAt) <= through.getTime();
      if (recent) items.push({ kind: "release", ...release });
    }
  }
  if (filings.status === "fulfilled") {
    for (const { form, date, url } of filings.value.filings) {
      const publishedAt = date + "T00:00:00.000Z";
      if (date >= since && Date.parse(publishedAt) <= through.getTime()) {
        items.push({ kind: "filing", form, publishedAt, url });
      }
    }
  }
  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const seen = new Set();
  const unique = items.filter(item => {
    const key = item.kind === "release" ? item.title.toLowerCase() : item.url ?? item.form + item.publishedAt;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    items: unique.slice(0, 6), marketMode: dataMode, days: windowDays,
    unavailable: { releases: releases.status === "rejected", filings: filings.status === "rejected" }
  };
}
