import { useCallback, useEffect, useRef, useState } from "react";
import { ChartNoAxesCombined, Clock3, PanelsTopLeft, Star, Wallet } from "lucide-react";
import { request, useResource } from "./api.js";
import { Auth } from "./Auth.jsx";
import { useLanguage } from "./language.jsx";
import { PriceChart, Notice } from "./ui.jsx";
import { Workspace } from "./Workspace.jsx";

const views = {
  research: ["AI Stock Research", "Run independent analyses and follow the evidence behind each score.", PanelsTopLeft, "Research"],
  watchlist: ["Watchlist", "Follow stocks you’re interested in and revisit your latest research.", Star],
  portfolio: ["Portfolio", "Enter the shares you own to track their value and unrealized gain or loss.", Wallet],
  history: ["Analysis history", "Reopen scores, explanations, and the evidence from previous runs.", Clock3],
};

function confirmationNotice() {
  const params = new URLSearchParams(location.hash.slice(1));
  const confirmed = params.get("type") === "signup" && params.has("access_token");
  const expired = params.get("error_code") === "otp_expired";
  if (confirmed || expired) window.history.replaceState(null, "", location.pathname + location.search);
  if (confirmed) return { message: "Email confirmed. Sign in to open your workspace." };
  if (expired) return { message: "This confirmation link is invalid or has expired. Sign in to continue or request a new link.", error: true };
}

function MarketOverview({ api, config, onSelect, hidden }) {
  const { t, money, dateLabel, signedPercent } = useLanguage();
  const { data, error } = useResource(api, "/api/market-overview");

  return <section className="market-overview" aria-labelledby="market-overview-title" hidden={hidden}>
    <div className="market-overview-header">
      <h2 id="market-overview-title">{t("Market highlights")}</h2>
      <p>{t(config.marketMode === "demo" ? "Synthetic closes · 20 sessions" : "Daily closes · 20 sessions")}</p>
    </div>
    <div className="market-tiles">
      {(data?.stocks ?? config.featuredStocks).map(({ ticker, name, prices }) => {
        const latest = prices?.at(-1);
        const previous = prices?.at(-2);
        const change = previous ? (latest.close - previous.close) / previous.close : null;
        const Tile = onSelect ? "button" : "article";
        return <Tile key={ticker} className="market-tile" type={onSelect ? "button" : undefined}
          onClick={onSelect ? () => onSelect(ticker) : undefined}>
          <div className="market-tile-identity"><strong>{ticker}</strong><span>{name}</span></div>
          {latest ? <>
            <div className="market-tile-value">
              <strong title={t("Closing price on {date}", { date: dateLabel(latest.date) })}>{money.format(latest.close)}</strong>
              {change !== null && <span className={change < 0 ? "market-change negative" : "market-change"}
                title={t("Change from previous close")}>{signedPercent.format(change)}</span>}
            </div>
            <PriceChart prices={prices} negative={change < 0} sparkline />
          </> : <span className="market-tile-status">{t(error || prices ? "Price unavailable" : "Loading price…")}</span>}
        </Tile>;
      })}
    </div>
  </section>;
}

function Footer() {
  const { t } = useLanguage();
  const disclosures = [
    ["Investment risk", "For research and education only. Review company disclosures and use your own judgment before buying, selling, or holding a stock. You could lose some or all of the money you invest."],
    ["AI analysis and scores", "AI-generated analysis can contain errors or miss important information. Scores rate the available evidence over the selected time horizon. Verify important claims against the original sources. Future prices and returns are uncertain."],
    ["Market data and portfolio values", "Live mode uses daily closing prices from Twelve Data and filings from SEC EDGAR. Prices may be delayed or unavailable. Demo mode uses synthetic data. Portfolio values are estimates based on the shares you enter and available closing prices."],
  ];
  const resources = [
    ["Researching investments", "https://www.investor.gov/introduction-investing/getting-started/researching-investments"],
    ["Finding SEC filings", "https://www.investor.gov/introduction-investing/getting-started/researching-investments/using-edgar-research-investments"],
    ["AI and investment fraud", "https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-alerts/artificial-intelligence-fraud"],
  ];

  return <footer className="site-footer" aria-labelledby="disclosures-title">
    <div className="footer-inner">
      <div className="footer-heading"><h2 id="disclosures-title" tabIndex={-1}>{t("Research disclosures")}</h2><a className="footer-home" href="/">AI Stock Research</a></div>
      <div className="footer-disclosures">{disclosures.map(([title, copy]) => <section key={title}><h3>{t(title)}</h3><p>{t(copy)}</p></section>)}</div>
      <nav className="footer-resources" aria-label={t("Investor resources")}>
        {resources.map(([title, href]) => <a key={title} href={href}>{t(title)}</a>)}
      </nav>
    </div>
  </footer>;
}

export function App() {
  const { t, language, setLanguage } = useLanguage();
  const config = useResource(request, "/api/config");
  const [session, setSession] = useState({ loading: true, version: 0 });
  const [notice, setNotice] = useState(confirmationNotice);
  const [view, setView] = useState("research");
  const [selection, setSelection] = useState(null);
  const [signingOut, setSigningOut] = useState(false);
  const [workspaceBlocked, setWorkspaceBlocked] = useState(false);
  const channel = useRef(null);
  const epoch = useRef(0);

  const applyAccount = useCallback((user) => {
    const version = ++epoch.current;
    setSession({ user, version });
    setView("research");
    setSelection(null);
    setWorkspaceBlocked(false);
  }, []);

  const loadAccount = useCallback(async () => {
    const version = epoch.current;
    const { user } = await request("/api/session");
    if (version === epoch.current) applyAccount(user);
  }, [applyAccount]);

  useEffect(() => {
    loadAccount().catch(error => {
      applyAccount(null);
      setNotice({ message: error.message, error: true });
    });
    if (typeof BroadcastChannel === "function") {
      channel.current = new BroadcastChannel("stock-research-session");
      channel.current.onmessage = ({ data }) => {
        if (data === "signed-in") location.reload();
        if (data === "signed-out") {
          setNotice(null);
          applyAccount(null);
        }
      };
    }
    const restore = event => { if (event.persisted) location.reload(); };
    window.addEventListener("pageshow", restore);
    return () => {
      channel.current?.close();
      window.removeEventListener("pageshow", restore);
    };
  }, [applyAccount, loadAccount]);

  const api = useCallback(async (path, options) => {
    const version = epoch.current;
    try { return await request(path, options); }
    catch (error) {
      if (error.status === 401 && version === epoch.current) {
        setNotice({ message: error.message, error: true });
        applyAccount(null);
      }
      throw error;
    }
  }, [applyAccount]);

  async function signIn() {
    await loadAccount();
    setNotice(null);
    channel.current?.postMessage("signed-in");
  }

  async function signOut() {
    setSigningOut(true);
    setWorkspaceBlocked(true);
    epoch.current += 1;
    try {
      await request("/api/logout", { method: "POST" });
      applyAccount(null);
      setNotice(null);
      channel.current?.postMessage("signed-out");
    } catch {
      setNotice({ message: "Sign-out could not be confirmed. Try signing out again.", error: true });
    } finally {
      setSigningOut(false);
    }
  }

  function openView(next) {
    setView(next);
    if (view !== next) window.scrollTo(0, 0);
  }

  function selectFeatured(ticker) {
    setSelection({ ticker });
    openView("research");
  }

  const user = session.user;
  const active = user && !workspaceBlocked;
  const [title, description] = views[active ? view : "research"];
  const name = user && (user.username ?? user.email ?? t("Demo workspace"));
  const demo = config.data?.marketMode === "demo";

  return <div className="shell">
    <a className="skip-link" href="#main-content">{t("Skip to content")}</a>
    <aside className="sidebar">
      <a className="brand" href="/" aria-label={t("AI Stock Research home")}>
        <span className="brand-mark" aria-hidden="true"><ChartNoAxesCombined size={18} /></span> AI Stock Research
      </a>
      {active && <nav className="navigation" aria-label={t("Workspace")}>
        {Object.entries(views).map(([key, [label, , Icon, navLabel]]) => <button key={key} type="button"
          className={view === key ? "nav-item selected" : "nav-item"} aria-current={view === key ? "page" : undefined}
          onClick={() => openView(key)}><Icon size={17} aria-hidden="true" /><span className="nav-label">{t(navLabel ?? label)}</span></button>)}
      </nav>}
      {user && <div className="sidebar-account">
        <div className="avatar" aria-hidden="true">{name[0].toUpperCase()}</div>
        <div className="account-text"><strong>{name}</strong>
          <button type="button" className="text-button" disabled={signingOut} onClick={signOut}>{t("Sign out")}</button>
        </div>
      </div>}
    </aside>
    <main className="content" id="main-content" tabIndex={-1}>
      <header className="page-top">
        <div><h1 id="view-title">{t(title)}</h1><p>{t(description)}</p></div>
        <div className="flex flex-wrap items-center justify-start gap-x-2.5 min-[601px]:justify-end gap-y-2">
          {config.data && <span className="data-state" data-mode={config.data.marketMode} title={t(demo ? "Sample prices and filings for demonstration"
            : "Daily closes from Twelve Data and company filings from SEC EDGAR")}>{t(demo ? "Synthetic demo data" : "Real market data")}</span>}
          <div className="language-switch" role="group" aria-label={t("Language")}>
            {[["en", "English"], ["de", "Deutsch"]].map(([code, label]) => <button key={code} type="button" lang={code}
              aria-pressed={language === code} onClick={() => setLanguage(code)}>{label}</button>)}
          </div>
        </div>
      </header>
      {config.data && (config.data.marketPreview || active) &&
        <MarketOverview api={config.data.marketPreview ? request : api} config={config.data}
          onSelect={active ? selectFeatured : null} hidden={Boolean(active && view !== "research")} />}
      {config.error && <div className="card workspace-editor">
        <Notice notice={{ message: config.error.message, error: true }} />
        <button className="secondary" type="button" onClick={config.reload}>{t("Retry")}</button>
      </div>}
      {(config.loading || session.loading) && <p className="empty" role="status">{t("Loading…")}</p>}
      {user && <Notice notice={notice} />}
      {config.data && !session.loading && (active
        ? <Workspace key={session.version} api={api} config={config.data} view={view} openView={openView} selection={selection} />
        : !user && <Auth config={config.data} onSignIn={signIn} initialNotice={notice} />)}
    </main>
    <Footer />
  </div>;
}
