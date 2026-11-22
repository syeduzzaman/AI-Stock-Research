import { useEffect, useId, useRef, useState } from "react";
import { useLanguage } from "./language.jsx";

export const ranges = { "1w": "1 week", "1m": "1 month", "3m": "3 months", "6m": "6 months" };
export const horizons = { "1w": "1W", "1m": "1M", "3m": "3M", "6m": "6M" };
export const marketPath = (ticker, horizon) => "/api/market?" + new URLSearchParams({ ticker, horizon });
export const isFilingLink = url => url?.startsWith("https://www.sec.gov/Archives/edgar/data/");

export function Notice({ notice }) {
  const { t, language } = useLanguage();
  if (!notice?.message) return null;
  const text = t(notice.message, notice.values);
  return <p className={notice.error ? "notice error" : "notice"} role="status">
    {notice.error && language === "de" && text === notice.message ? t("The request could not be completed.") : text}
  </p>;
}

export function AgentName({ agent, index }) {
  const { t } = useLanguage();
  return t("Agent {number} · {name}", { number: index + 1, name: t(agent.name) });
}

export function StockActions({ ticker, watched, position, busy, onWatch, onHolding, label = "Research stock actions" }) {
  const { t } = useLanguage();
  return <div className="stock-actions" role="group" aria-label={t(label)}>
    <button className="secondary" type="button" aria-pressed={watched} disabled={busy} onClick={() => onWatch(ticker, !watched)}>
      {t(watched ? "★ On watchlist" : "☆ Add to watchlist")}
    </button>
    <button className="secondary" type="button" onClick={() => onHolding(ticker)}>{t(position ? "Edit holding" : "Add holding")}</button>
  </div>;
}

export function StockOptions({ stocks }) {
  return stocks.map(stock => <option key={stock.ticker} value={stock.ticker}>{stock.ticker} · {stock.name}</option>);
}

export function PriceChart({ prices, negative, label, sparkline = false }) {
  const ref = useRef(null);
  const plot = useRef(null);
  const id = useId();
  const { t, money, dateLabel } = useLanguage();
  const [cursor, setCursor] = useState(null);
  const index = Math.min(cursor ?? Infinity, (prices?.length ?? 0) - 1);
  const point = prices?.[index];
  const pointLabel = point ? dateLabel(point.date) + " · " + money.format(point.close) : "";
  useEffect(() => {
    const canvas = ref.current;
    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      if (!prices?.length) return;
      const ctx = canvas.getContext("2d");
      ctx.scale(ratio, ratio);
      ctx.font = "11px Segoe UI";
      const palette = getComputedStyle(canvas);
      const color = palette.getPropertyValue(negative ? "--red" : "--up").trim();
      const closes = prices.map(point => point.close);
      const low = Math.min(...closes);
      const spread = Math.max(Math.max(...closes) - low, 0.1);
      const margin = sparkline ? 2 : 10;
      const right = sparkline ? width - margin : width - Math.max(61, ctx.measureText(money.format(low + spread)).width + 12);
      const x = index => margin + (right - margin) * index / Math.max(1, closes.length - 1);
      const y = price => height - margin - (price - low) / spread * (height - 2 * margin);
      plot.current = { left: margin, right };

      if (!sparkline) {
        ctx.strokeStyle = palette.getPropertyValue("--line").trim();
        ctx.fillStyle = palette.getPropertyValue("--muted").trim();
        for (let index = 0; index < 4; index += 1) {
          const price = low + spread * index / 3;
          ctx.beginPath();
          ctx.moveTo(margin, y(price));
          ctx.lineTo(right, y(price));
          ctx.stroke();
          ctx.fillText(money.format(price), right + 6, y(price) + 4);
        }
      }

      const path = () => {
        ctx.beginPath();
        ctx.moveTo(x(0), y(closes[0]));
        closes.slice(1).forEach((price, index) => ctx.lineTo(x(index + 1), y(price)));
      };
      const fade = ctx.createLinearGradient(0, 0, 0, height);
      fade.addColorStop(0, color + "30");
      fade.addColorStop(1, color + "00");
      path();
      ctx.lineTo(right, height);
      ctx.lineTo(margin, height);
      ctx.closePath();
      ctx.fillStyle = fade;
      ctx.fill();
      path();
      ctx.strokeStyle = color;
      ctx.lineWidth = sparkline ? 1.4 : 2;
      ctx.stroke();

      if (!sparkline && cursor !== null && closes[index] !== undefined) {
        const marker = x(index);
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = palette.getPropertyValue("--muted").trim();
        ctx.lineWidth = 1;
        ctx.moveTo(marker, margin);
        ctx.lineTo(marker, height - margin);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(marker, y(closes[index]), 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [prices, negative, sparkline, money, cursor, index]);

  function inspect(event) {
    if (!plot.current || !prices?.length) return;
    const { left, right } = plot.current;
    const offset = event.clientX - ref.current.getBoundingClientRect().left;
    const fraction = Math.max(0, Math.min(1, (offset - left) / (right - left)));
    setCursor(Math.round(fraction * (prices.length - 1)));
  }

  if (sparkline) return <canvas ref={ref} className="market-sparkline" aria-hidden="true" />;

  return <>
    <div className="chart-wrap">
      <canvas ref={ref} className="block h-full w-full" role="img" aria-label={label}
        onPointerMove={event => { if (event.pointerType === "mouse") inspect(event); }} onClick={inspect} />
    </div>
    {prices?.length > 1 && <div className="chart-inspector">
      <input id={id} type="range" min={0} max={prices.length - 1} value={index}
        aria-label={t("Inspect closing prices")} aria-valuetext={pointLabel}
        onChange={event => setCursor(event.target.valueAsNumber)} />
      <output htmlFor={id} aria-live="off"><time dateTime={point.date}>{dateLabel(point.date)}</time>
        <strong>{money.format(point.close)}</strong></output>
    </div>}
  </>;
}
