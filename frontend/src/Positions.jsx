import { useEffect, useRef, useState } from "react";
import { useResource } from "./api.js";
import { useLanguage } from "./language.jsx";
import { isFilingLink, marketPath, ranges, StockOptions } from "./ui.jsx";

const direction = value => value ? (value > 0 ? "up" : "down") : undefined;

function useQuotes(api, tickers) {
  const key = [...new Set(tickers)].sort().join(",");
  const [state, setState] = useState({});
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    Promise.all(key.split(",").map(async ticker => {
      try {
        const { prices } = await api(marketPath(ticker, "1w"), { signal: controller.signal });
        const latest = prices.at(-1);
        const previous = prices.at(-2);
        return [ticker, latest && { ...latest, change: previous ? (latest.close - previous.close) / previous.close : null }];
      } catch {
        return [ticker, null];
      }
    })).then(quotes => {
      if (!controller.signal.aborted) setState({ key, quotes: Object.fromEntries(quotes) });
    });
    return () => controller.abort();
  }, [api, key]);
  return state.key === key ? state.quotes : null;
}

function Metric({ label, value = "—", detail, change }) {
  const { t } = useLanguage();
  return <div><dt>{t(label)}</dt><dd data-direction={direction(change)}>{value}{detail && <small>{detail}</small>}</dd></div>;
}

function CloseMetric({ quote, loading }) {
  const { t, money, dateLabel } = useLanguage();
  return <Metric label="Latest close" value={quote ? money.format(quote.close) : t(loading ? "Loading…" : "Unavailable")}
    detail={quote && dateLabel(quote.date)} />;
}

function Position({ ticker, subtitle, openStock, actions, children }) {
  const { t } = useLanguage();
  return <article className="card position-row">
    <div className="position-heading">
      <div><h3>{ticker}</h3><p>{subtitle}</p></div>
      <div className="row-actions">
        <button type="button" className="secondary" aria-label={t("Research {ticker}", { ticker })}
          onClick={() => openStock(ticker)}>{t("Research")}</button>{actions}
      </div>
    </div>
    <dl className="position-metrics">{children}</dl>
  </article>;
}

function EmptyPosition({ title, children }) {
  const { t } = useLanguage();
  return <article className="card position-empty"><h3>{t(title)}</h3><p>{t(children)}</p></article>;
}

function WatchUpdates({ api, watchlist, openStock }) {
  const { t, money, signedPercent, dateLabel } = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const { data, error, loading, reload } = useResource(api, watchlist.length ? "/api/watchlist/updates" : null);
  const visible = data?.events.slice(0, expanded ? undefined : 6) ?? [];
  const hasUnavailable = data && (data.unavailable.prices.length || data.unavailable.filings.length);
  const status = [
    !watchlist.length && t("Add a stock to see its filings and daily price moves here."),
    loading && t("Loading watchlist updates…"),
    error && t(data ? "Refresh failed. Showing the last loaded updates." : "Updates could not be loaded. Try refreshing."),
    data?.unavailable.prices.length > 0 && t("Price moves unavailable for {stocks}.", { stocks: data.unavailable.prices.join(", ") }),
    data?.unavailable.filings.length > 0 && t("Filings unavailable for {stocks}.", { stocks: data.unavailable.filings.join(", ") }),
    data && !data.events.length && t(hasUnavailable ? "No updates from the available data." : "No qualifying updates in this period."),
    data && visible.length < data.total && t("Showing {shown} of {total} updates.", { shown: visible.length, total: data.total }),
  ].filter(Boolean).join(" ");

  return <section className="card watch-updates">
    <div className="watch-updates-header">
      <div><h2>{t("Watchlist updates")}</h2>
        <p>{data ? t("Past {days} days · Close-to-close moves of {minimum}% or more", { days: data.days, minimum: data.minimumMove })
          : t("Recent filings and large moves in daily closing prices.")}</p></div>
      {watchlist.length > 0 && <button className="secondary" type="button" disabled={loading} onClick={reload}>{t("Refresh updates")}</button>}
    </div>
    {status && <p className="watch-updates-status" role="status">{status}</p>}
    <ul id="watch-updates-list" className="watch-updates-list" aria-busy={loading}>
      {visible.map(({ ticker, kind, date, form, url, change, close }) => <li className="watch-update" key={[ticker, kind, date, form, url].join("|")}>
        <div><p className="watch-update-title"><strong>{ticker}</strong><span>{t(kind === "price" ? "Daily price move" : "SEC Form {form}", { form })}</span>
          {kind === "price" && <strong className="watch-update-move" data-direction={direction(change)}>{signedPercent.format(change / 100)}</strong>}</p>
          <p className="watch-update-date"><time dateTime={date}>{dateLabel(date)}</time>
            {kind === "price" ? " · " + t("Close {price}", { price: money.format(close) }) : !url && " · " + t("Demo filing")}</p></div>
        <div className="row-actions">
          {isFilingLink(url) && <a className="secondary" href={url} target="_blank" rel="noopener noreferrer"
            aria-label={t("Open {ticker} SEC Form {form}", { ticker, form })}>{t("Open SEC filing")}</a>}
          <button type="button" className="secondary" onClick={() => openStock(ticker)}
            aria-label={t("Research {ticker}", { ticker })}>{t("Research")}</button>
        </div>
      </li>)}
    </ul>
    {data?.events.length > 6 && <button type="button" className="text-button watch-updates-more" aria-expanded={expanded}
      aria-controls="watch-updates-list" onClick={() => setExpanded(value => !value)}>{t(expanded ? "Show fewer updates" : "Show more updates")}</button>}
  </section>;
}

export function Watchlist({ api, config, watchlist, history, openStock, openResult, updateWatch, busy }) {
  const { t, signedPercent, dateLabel } = useLanguage();
  const [selected, setSelected] = useState("");
  const quotes = useQuotes(api, watchlist);
  const available = config.stocks.filter(stock => !watchlist.includes(stock.ticker));
  const selection = available.some(stock => stock.ticker === selected) ? selected : "";

  return <section className="view workspace-list" aria-labelledby="view-title">
    <article className="card workspace-editor">
      <h2>{t("Add to watchlist")}</h2>
      {available.length ? <form className="watch-form" onSubmit={event => {
        event.preventDefault();
        if (selection) updateWatch(selection, true);
        setSelected("");
      }}>
        <label htmlFor="watch-stock">{t("Stock")}</label>
        <select id="watch-stock" required value={selection} disabled={busy} onChange={event => setSelected(event.target.value)}>
          <option value="">{t("Choose a stock")}</option><StockOptions stocks={available} />
        </select>
        <button className="primary" disabled={busy || !selection}>{t("Add stock")}</button>
      </form> : <p className="empty">{t("All covered stocks are already on your watchlist.")}</p>}
    </article>
    <WatchUpdates key={watchlist.join(",")} {...{ api, watchlist, openStock }} />
    <div className="position-list">{watchlist.length ? watchlist.map(ticker => {
      const stock = config.stocks.find(item => item.ticker === ticker);
      const run = history.find(item => item.ticker === ticker);
      const change = quotes?.[ticker]?.change;
      return <Position key={ticker} ticker={ticker} subtitle={t(stock?.sector ?? "Saved stock")} openStock={openStock}
        actions={<button type="button" className="secondary" disabled={busy} aria-label={t("Remove {ticker} from watchlist", { ticker })}
          onClick={() => updateWatch(ticker, false)}>{t("Remove")}</button>}>
        <CloseMetric quote={quotes?.[ticker]} loading={!quotes} />
        <Metric label="1-day change" value={change == null ? "—" : signedPercent.format(change)} change={change} />
        <Metric label="Latest saved analysis" value={run ? <button type="button" className="text-button" onClick={() => openResult(run)}>
          {run.score == null ? t("Unscored") : run.score + "/100"} · {t(ranges[run.horizon])}
        </button> : t("No analysis yet")} detail={run && dateLabel(run.createdAt)} />
      </Position>;
    }) : <EmptyPosition title="No stocks on your watchlist">Choose a stock above, or add it while you’re viewing its chart or analysis.</EmptyPosition>}</div>
  </section>;
}

function HoldingForm({ config, portfolio, holding, setHolding, selectHolding, updateHolding, busy }) {
  const { t } = useLanguage();
  const sharesInput = useRef(null);
  const editing = portfolio.some(item => item.ticker === holding.ticker);
  useEffect(() => { if (holding.ticker) sharesInput.current?.focus(); }, [holding.ticker]);

  return <article className="card workspace-editor">
    <h2 id="holding-title">{editing ? t("Edit {ticker} holding", { ticker: holding.ticker }) : t("Add a holding")}</h2>
    <form aria-labelledby="holding-title" onSubmit={event => {
      event.preventDefault();
      void updateHolding(holding.ticker, Number(holding.shares), Number(holding.cost));
    }}>
      <fieldset className="holding-form" disabled={busy}>
        <label><span>{t("Stock")}</span><select required value={holding.ticker} onChange={event => selectHolding(event.target.value)}>
          <option value="">{t("Choose a stock")}</option><StockOptions stocks={config.stocks} />
        </select></label>
        {[["Shares", "shares"], ["Average cost per share (USD)", "cost"]].map(([label, key]) => <label key={key}>
          <span>{t(label)}</span><input ref={key === "shares" ? sharesInput : undefined} required type="number"
            min="0.000001" step="0.000001" max="10000000" value={holding[key]}
            onChange={event => setHolding({ ...holding, [key]: event.target.value })} />
        </label>)}
        <div className="row-actions">
          {holding.ticker && <button className="text-button" type="button" onClick={() => selectHolding()}>{t("Cancel")}</button>}
          <button className="primary">{t(editing ? "Save changes" : "Add holding")}</button>
        </div>
      </fieldset>
    </form>
  </article>;
}

export function Portfolio({ api, config, portfolio, holding, setHolding, openStock, selectHolding, updateHolding, busy }) {
  const { t, money, signedMoney, signedPercent, shareCount } = useLanguage();
  const quotes = useQuotes(api, portfolio.map(item => item.ticker));
  const positions = portfolio.map(({ ticker, shares, average_cost: cost }) => {
    const quote = quotes?.[ticker];
    return { ticker, shares, cost, quote, basis: shares * cost, value: quote && quote.close * shares };
  });
  const priced = positions.filter(position => position.quote);
  const sum = (items, key) => items.reduce((total, position) => total + position[key], 0);
  const current = sum(priced, "value");
  const basis = sum(priced, "basis");
  const merit = current - basis;

  return <section className="view workspace-list" aria-labelledby="view-title">
    {positions.length > 0 && <section className="card portfolio-overview">
      <h2>{t("Portfolio overview")}</h2>
      <dl className="position-metrics">
        <Metric label="Total cost basis" value={money.format(sum(positions, "basis"))} />
        <Metric label="Market value" value={priced.length ? money.format(current) : t(quotes ? "Unavailable" : "Loading…")} />
        <Metric label="Unrealized gain or loss" value={priced.length ? signedMoney.format(merit) : "—"} change={merit}
          detail={basis > 0 && signedPercent.format(merit / basis)} />
      </dl>
      {quotes && <p className="empty" role="status">{t(!priced.length ? "Closing prices are unavailable for all holdings."
        : priced.length < positions.length ? "Market value and gain or loss cover {priced} of {total} holdings with available prices."
          : config.marketMode === "demo" ? "Based on synthetic closes." : "Based on the latest available closing prices.", {
        priced: priced.length, total: positions.length,
      })}</p>}
    </section>}
    <HoldingForm {...{ config, portfolio, holding, setHolding, selectHolding, updateHolding, busy }} />
    <div className="position-list">{positions.length ? positions.map(({ ticker, shares, cost, quote, basis, value }) => {
      const gain = quote && value - basis;
      return <Position key={ticker} ticker={ticker} subtitle={t(Number(shares) === 1 ? "{count} share" : "{count} shares", { count: shareCount.format(shares) })}
        openStock={openStock} actions={<>
          <button type="button" className="secondary" disabled={busy} aria-label={t("Edit {ticker} holding", { ticker })}
            onClick={() => selectHolding(ticker)}>{t("Edit")}</button>
          <button type="button" className="secondary" disabled={busy} aria-label={t("Remove {ticker} holding", { ticker })}
            onClick={() => { if (window.confirm(t("Remove {ticker} from your portfolio?", { ticker }))) void updateHolding(ticker, 0, 0); }}>{t("Remove")}</button>
        </>}>
        <Metric label="Average cost" value={money.format(cost)} />
        <Metric label="Cost basis" value={money.format(basis)} />
        <CloseMetric quote={quote} loading={!quotes} />
        <Metric label="Market value" value={quote ? money.format(value) : "—"} />
        <Metric label="Unrealized gain or loss" value={quote ? signedMoney.format(gain) : "—"}
          detail={quote && signedPercent.format(gain / basis)} change={gain} />
      </Position>;
    }) : <EmptyPosition title="No holdings yet">Add a stock you own with the number of shares and what you paid per share.</EmptyPosition>}</div>
  </section>;
}
