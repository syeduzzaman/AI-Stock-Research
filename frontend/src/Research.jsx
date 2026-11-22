import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import { AnalysisResult } from "./AnalysisResult.jsx";
import { useResource } from "./api.js";
import { useLanguage } from "./language.jsx";
import { AgentName, horizons, isFilingLink, marketPath, PriceChart, StockActions } from "./ui.jsx";

function StockSearch({ stocks, onSelect }) {
  const { t } = useLanguage();
  const [term, setTerm] = useState("");
  const [universe, setUniverse] = useState("all");
  const [expanded, setExpanded] = useState(false);
  const firstMatch = useRef(null);
  const needle = term.trim().toLowerCase();
  const matches = stocks.filter(stock => (universe === "all" || stock.indexes.includes(universe)) &&
    (stock.ticker.toLowerCase().includes(needle) || stock.name.toLowerCase().includes(needle)));

  function choose(ticker) {
    setExpanded(false);
    setTerm("");
    onSelect(ticker);
  }

  return <div className="stock-search" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false);
  }} onKeyDown={event => {
    if (event.key === "Escape") setExpanded(false);
  }}>
    <label className="search-label">
      <Search size={19} aria-hidden="true" />
      <input type="search" placeholder={t("Search symbol or company")} aria-label={t("Search symbol or company")}
        value={term} autoComplete="off" onFocus={() => setExpanded(true)}
        onChange={event => { setTerm(event.target.value); setExpanded(true); }}
        onKeyDown={event => {
          if (!expanded || !matches.length) return;
          if (event.key === "Enter") { event.preventDefault(); choose(matches[0].ticker); }
          if (event.key === "ArrowDown") { event.preventDefault(); firstMatch.current?.focus(); }
        }} />
    </label>
    <select value={universe} aria-label={t("Filter covered companies")} onChange={event => {
      setUniverse(event.target.value);
      setExpanded(true);
    }}>
      {[["all", "All covered stocks"], ["nasdaq", "Nasdaq-100 sample"], ["sp500", "S&P 500 sample"]]
        .map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
    </select>
    {expanded && <div className="search-results">
      {matches.length ? matches.map(({ ticker, name }, index) => <button key={ticker} className="text-left" type="button"
        ref={index === 0 ? firstMatch : undefined} onClick={() => choose(ticker)}><strong>{ticker}</strong><span>{name}</span></button>)
        : <p className="empty">{t("No covered stock matched.")}</p>}
    </div>}
  </div>;
}

function CompanyNews({ ticker, api }) {
  const { t, dateLabel } = useLanguage();
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  const { data, error, loading, reload } = useResource(api, visible ? "/api/company-news?" + new URLSearchParams({ ticker }) : null);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "180px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  const demo = data?.marketMode === "demo";
  const releaseFailed = data?.unavailable.releases;
  const filingFailed = data?.unavailable.filings;
  const status = [
    loading && t("Loading company news…"),
    error && t("Company news could not be loaded. Try again."),
    releaseFailed && t("Company press releases are temporarily unavailable."),
    filingFailed && t("SEC filings are temporarily unavailable."),
    data && !data.items.length && !releaseFailed && !filingFailed &&
      t("No company press releases or SEC filings in the past {days} days.", { days: data.days }),
  ].filter(Boolean);

  return <section ref={ref} className="card company-news" aria-labelledby="company-news-title">
    <div className="company-news-header">
      <div>
        <h2 id="company-news-title">{t("Latest news for {ticker}", { ticker })}</h2>
        <p>{t("Recent company press releases and SEC filings.")}</p>
      </div>
      {!loading && (error || releaseFailed || filingFailed) && <button type="button" className="secondary" onClick={reload}>{t("Retry news")}</button>}
    </div>
    {status.length > 0 && <p className="company-news-status" role="status">{status.join(" ")}</p>}
    <ul className="company-news-items" aria-labelledby="company-news-title" aria-busy={loading}>
      {data?.items.map(item => {
        const release = item.kind === "release";
        const title = release ? (demo ? t(item.title) : item.title) : t("SEC Form {form}", { form: item.form });
        const source = t(demo ? (release ? "Demo press release" : "Demo filing") : (release ? "Company press release · Twelve Data" : "SEC EDGAR"));
        const lang = release && !demo ? "en" : undefined;
        return <li key={item.publishedAt + title} className="company-news-item">
          <div><p className="company-news-meta">{source} · <time dateTime={item.publishedAt}>{dateLabel(item.publishedAt)}</time></p>
            <h3 lang={lang}>{title}</h3>
            {item.excerpt && <p className="company-news-excerpt" lang={lang}>{demo ? t(item.excerpt) : item.excerpt}</p>}
          </div>
          {isFilingLink(item.url) && <a className="secondary" href={item.url} target="_blank" rel="noopener noreferrer">{t("Open SEC filing")}</a>}
        </li>;
      })}
    </ul>
  </section>;
}

function AnalysisForm({ settings, update, providers, agents, running, onRun, onSave }) {
  const { t } = useLanguage();
  const demo = settings.provider === "demo";
  return <article className="card setup">
    <h2>{t(demo ? "Demo stock analysis" : "AI stock analysis")}</h2>
    <form onSubmit={event => { event.preventDefault(); onRun(); }}>
      <fieldset><legend>{t("Time horizon")}</legend><div className="segmented">
        {Object.entries(horizons).map(([key, label]) => <label key={key}><input type="radio" name="horizon" value={key}
          checked={settings.horizon === key} onChange={() => update({ horizon: key })} /><span>{t(label)}</span></label>)}
      </div></fieldset>
      <label className="field-label" htmlFor="provider">{t("Model")}</label>
      <select id="provider" value={settings.provider} onChange={event => update({ provider: event.target.value })}>
        {!settings.provider && <option value="" disabled>{t("setup required")}</option>}
        {providers.map(({ id, label, model, enabled }) => <option key={id} value={id} disabled={!enabled} title={model ?? undefined}>
          {t(label)}{!enabled && " · " + t("setup required")}
        </option>)}
      </select>
      <fieldset><legend>{t("Agents")}</legend><div className="segmented">
        {[3, 5].map(count => <label key={count}><input type="radio" name="agents" value={count}
          checked={settings.agentCount === count} onChange={() => update({ agentCount: count })} /><span>{t(count + " agents")}</span></label>)}
      </div></fieldset>
      <ul className="agent-preview">{agents.slice(0, settings.agentCount).map((agent, index) =>
        <li key={agent.id}><AgentName agent={agent} index={index} /></li>
      )}</ul>
      <button className="primary run" type="submit" disabled={running || !settings.provider} aria-busy={running}>
        {t(running ? "Running analysis…" : demo ? "Run demo analysis" : "Run AI analysis")} <ArrowUpRight size={17} aria-hidden="true" />
      </button>
      <button className="text-button save-pref" type="button" disabled={!settings.provider} onClick={onSave}>{t("Save these defaults")}</button>
    </form>
  </article>;
}

export function Research({ api, stock, config, settings, updateSettings, openStock, actions, history, result, onOpen, onRun, running, onSave }) {
  const { t, money, signedPercent, dateLabel, calendar } = useLanguage();
  const { data: market, error } = useResource(api, marketPath(stock.ticker, settings.horizon));
  const metrics = market?.metrics;
  const change = metrics && signedPercent.format(metrics.change / 100);
  const providers = config.providers.filter(provider => config.marketMode !== "live" || provider.id !== "demo");

  return <section className="view" aria-labelledby="view-title">
    <div className="research-grid">
      <article className="card stock-card">
        <StockSearch stocks={config.stocks} onSelect={openStock} />
        <div className="stock-header">
          <div className="stock-identity"><span className="stock-logo" aria-hidden="true">{stock.ticker[0]}</span>
            <div><h2>{stock.name}</h2><p>{stock.ticker} · {t(stock.sector)}</p></div></div>
          <StockActions {...actions} />
        </div>
        <div className="quote"><strong>{metrics ? money.format(metrics.last) : "—"}</strong>
          {metrics && <span className={metrics.change < 0 ? "negative" : undefined}>{change}</span>}</div>
        <p className="market-date">{metrics
          ? [t(market.marketMode === "demo" ? "Synthetic close" : "Latest available close"), dateLabel(metrics.asOf),
            t("{count} trading sessions", { count: metrics.sessions })].join(" · ")
          : t(error ? "Closing prices are unavailable. Check the market data configuration." : "Loading closing prices…")}</p>
        <div className="chart-wrap">
          <PriceChart prices={market?.prices.slice(-metrics.sessions - 1)} negative={metrics?.change < 0}
            label={metrics ? t("{ticker} closing prices from {from} to {to}, change {change}.", {
              ticker: stock.ticker, from: dateLabel(metrics.from), to: dateLabel(metrics.asOf), change,
            }) : t("Closing-price chart for the selected horizon")} />
        </div>
        {metrics && <div className="chart-labels" aria-hidden="true">
          <span>{calendar.format(new Date(metrics.from))}</span><span>{calendar.format(new Date(metrics.asOf))}</span>
        </div>}
      </article>
      <AnalysisForm settings={settings} update={updateSettings} providers={providers} agents={config.agents}
        running={running} onRun={onRun} onSave={onSave} />
    </div>
    {result && <AnalysisResult key={result.id} result={result} history={history} providers={config.providers} actions={actions} onOpen={onOpen} />}
    <CompanyNews key={stock.ticker} ticker={stock.ticker} api={api} />
  </section>;
}
