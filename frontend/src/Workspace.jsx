import { useEffect, useRef, useState } from "react";
import { useResource } from "./api.js";
import { outlook } from "./AnalysisResult.jsx";
import { useLanguage } from "./language.jsx";
import { Research } from "./Research.jsx";
import { Notice, ranges } from "./ui.jsx";
import { Portfolio, Watchlist } from "./Positions.jsx";

export function Workspace({ api, config, view, openView, selection }) {
  const { t } = useLanguage();
  const workspace = useResource(api, "/api/workspace");
  if (workspace.error) return <div className="card workspace-editor">
    <Notice notice={{ message: workspace.error.message, error: true }} />
    <button className="secondary" type="button" onClick={workspace.reload}>{t("Retry")}</button>
  </div>;
  if (!workspace.data) return <p className="empty" role="status">{t("Loading…")}</p>;
  return <ResearchWorkspace {...{ api, config, view, openView, selection }} initial={workspace.data} />;
}

function normalizeSettings(config, input) {
  const available = config.providers.filter(provider => provider.enabled && (config.marketMode !== "live" || provider.id !== "demo"));
  return {
    agentCount: input.agentCount ?? 5,
    horizon: input.horizon ?? "1m",
    provider: available.find(provider => provider.id === input.provider)?.id ?? available[0]?.id ?? "",
  };
}

function ResearchWorkspace({ api, config, view, openView, selection, initial }) {
  const { t } = useLanguage();
  const [ticker, setTicker] = useState(initial.watchlist.find(ticker => config.stocks.some(stock => stock.ticker === ticker)) ?? config.stocks[0].ticker);
  const [settings, setSettings] = useState(() => normalizeSettings(config, initial.preferences));
  const [watchlist, setWatchlist] = useState(initial.watchlist);
  const [portfolio, setPortfolio] = useState(initial.portfolio);
  const [history, setHistory] = useState(initial.history);
  const [result, setResult] = useState(null);
  const [notice, setNotice] = useState(null);
  const [watchBusy, setWatchBusy] = useState(false);
  const [holdingBusy, setHoldingBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [holding, setHolding] = useState({ ticker: "", shares: "", cost: "" });
  const activeTicker = useRef(ticker);
  const activeView = useRef(view);
  activeView.current = view;
  const stock = config.stocks.find(item => item.ticker === ticker);

  useEffect(() => {
    setNotice(null);
  }, [view]);

  useEffect(() => {
    if (!selection) return;
    setNotice(null);
    activeTicker.current = selection.ticker;
    setTicker(selection.ticker);
    setResult(null);
  }, [selection]);

  function openStock(next) {
    setNotice(null);
    activeTicker.current = next;
    setTicker(next);
    setResult(null);
    openView("research");
  }

  function openResult(run) {
    openStock(run.ticker);
    setSettings(normalizeSettings(config, run));
    setResult(run);
  }

  function selectHolding(nextTicker = "") {
    const row = portfolio.find(item => item.ticker === nextTicker);
    setHolding({ ticker: nextTicker, shares: row?.shares ?? "", cost: row?.average_cost ?? "" });
  }

  function openHolding(nextTicker) {
    selectHolding(nextTicker);
    openView("portfolio");
  }

  async function updateWatch(ticker, add) {
    if (watchBusy) return false;
    setWatchBusy(true);
    try {
      const data = await api("/api/watchlist", { method: "PUT", input: { ticker, add } });
      setWatchlist(data.watchlist);
      setNotice({ message: add ? "{ticker} added to your watchlist." : "{ticker} removed from your watchlist.", values: { ticker } });
      return true;
    } catch (error) {
      setNotice({ message: error.message, error: true });
      return false;
    } finally {
      setWatchBusy(false);
    }
  }

  async function updateHolding(ticker, shares, averageCost) {
    if (holdingBusy) return;
    setHoldingBusy(true);
    try {
      const data = await api("/api/holdings", { method: "PUT", input: { ticker, shares, averageCost } });
      setPortfolio(data.portfolio);
      if (shares || holding.ticker === ticker) setHolding({ ticker: "", shares: "", cost: "" });
      setNotice({ message: shares ? "{ticker} holding saved." : "{ticker} holding removed.", values: { ticker } });
    } catch (error) {
      setNotice({ message: error.message, error: true });
    } finally {
      setHoldingBusy(false);
    }
  }

  async function run() {
    if (running || !settings.provider) return;
    setRunning(true);
    setNotice(null);
    try {
      const { result } = await api("/api/analysis", { method: "POST", input: { ticker, ...settings } });
      setHistory(items => [result, ...items].slice(0, 75));
      if (ticker === activeTicker.current) setResult(result);
      if (ticker !== activeTicker.current || activeView.current !== "research") {
        setNotice({ message: "{ticker} analysis saved to history.", values: { ticker } });
      }
    } catch (error) {
      setNotice({ message: error.message, error: true });
    } finally {
      setRunning(false);
    }
  }

  async function savePreferences() {
    try {
      await api("/api/preferences", { method: "PUT", input: settings });
      setNotice({ message: "Analysis defaults saved." });
    } catch (error) {
      setNotice({ message: error.message, error: true });
    }
  }

  return <>
    <Notice notice={notice} />
    {view === "research" && stock && <Research {...{ api, stock, config, settings, openStock, history, result, running }}
      updateSettings={patch => setSettings(previous => ({ ...previous, ...patch }))}
      actions={{ ticker, busy: watchBusy, watched: watchlist.includes(ticker), position: portfolio.some(item => item.ticker === ticker),
        onWatch: updateWatch, onHolding: openHolding }}
      onOpen={openResult} onRun={run} onSave={savePreferences} />}
    {view === "watchlist" && <Watchlist {...{ api, config, watchlist, history, openStock, openResult, updateWatch }} busy={watchBusy} />}
    {view === "portfolio" && <Portfolio {...{ api, config, portfolio, holding, setHolding, openStock, selectHolding, updateHolding }} busy={holdingBusy} />}
    {view === "history" && <History {...{ history, config, openResult }} />}
  </>;
}

function History({ history, config, openResult }) {
  const { t, runDate } = useLanguage();
  const [ticker, setTicker] = useState("");
  const tickers = [...new Set(history.map(run => run.ticker))].sort();
  const runs = ticker ? history.filter(run => run.ticker === ticker) : history;

  return <section className="view card table-card" aria-labelledby="view-title">
    {tickers.length > 1 && <div className="history-filter">
      <label htmlFor="history-ticker">{t("Filter analyses by stock")}</label>
      <select id="history-ticker" value={ticker} onChange={event => setTicker(event.target.value)}>
        <option value="">{t("All analyzed stocks")}</option>
        {tickers.map(symbol => <option key={symbol} value={symbol}>{symbol}</option>)}
      </select>
    </div>}
    {runs.length ? <ul className="history-list">{runs.map(run => {
      const [, tone, signal] = outlook(run.score);
      return <li className="list-row" key={run.id}>
        <div>
          <div className="history-heading"><strong>{run.ticker} · {t(ranges[run.horizon])}</strong>
            <span className="history-signal" data-outlook={tone}>
              {Number.isFinite(run.score) ? run.score + "/100 · " : ""}{t(signal)}
            </span>
          </div>
          <p>{t(config.providers.find(provider => provider.id === run.provider)?.label ?? run.provider)}
            {" · "}<time dateTime={run.createdAt}>{runDate.format(new Date(run.createdAt))}</time>
          </p>
        </div>
        <button type="button" className="secondary" onClick={() => openResult(run)}>{t("Open result")}</button>
      </li>;
    })}</ul> : <p className="empty">{t("Run an analysis to start your history.")}</p>}
  </section>;
}
