import { useEffect, useRef } from "react";
import { compareWithPrevious } from "./analysis-comparison.js";
import { useLanguage } from "./language.jsx";
import { AgentName, ranges, StockActions } from "./ui.jsx";

const bands = [
  [80, "strong-upside", "Strong upside signal", "Strongly favorable", "The scored evidence strongly favors an increase over this time horizon."],
  [65, "upside", "Upside lean", "Favorable", "The scored evidence leans toward an increase over this time horizon."],
  [45, "mixed", "Mixed outlook", "Mixed evidence", "The combined evidence gives no clear direction over this time horizon."],
  [30, "downside", "Downside lean", "Unfavorable", "The scored evidence leans toward a decline over this time horizon."],
  [0, "strong-downside", "Strong downside signal", "Strongly unfavorable", "The scored evidence strongly favors a decline over this time horizon."],
];
const unscored = [null, "unscored", "Unscored", "Unscored", "None of the agents produced a usable score. Check their explanations below."];

export function outlook(score) {
  return (Number.isFinite(score) && bands.find(([min]) => score >= min)) || unscored;
}

function ScoreRing({ score }) {
  const { t } = useLanguage();
  const present = Number.isFinite(score);
  return <div className="score-ring" data-outlook={outlook(score)[1]} role="img"
    aria-label={present ? t("{score} out of 100", { score }) : t("Unscored")}
    style={present ? { "--score-progress": score / 100 + "turn" } : undefined}>
    <div className="score-ring-value" aria-hidden="true">
      <strong>{present ? score : "—"}</strong>{present && <span>/ 100</span>}
    </div>
  </div>;
}

function rationaleFor(agent, { language, t, decimal }) {
  if (language === "en") return agent.rationale;
  if (agent.rationaleDe) return agent.rationaleDe;
  const translated = t(agent.rationale);
  if (translated !== agent.rationale) return translated;
  const cash = /^Illustrative cash of \$([\d.]+)B versus \$([\d.]+)B of fixture debt\./.exec(agent.rationale);
  if (cash) return t("Illustrative cash of ${cash}B versus ${debt}B of fixture debt. Operating cash generation also affects the score.", {
    cash: decimal.format(Number(cash[1])), debt: decimal.format(Number(cash[2])),
  });
  const momentum = /^Synthetic closing prices moved (-?[\d.]+)% over (\d+) sessions\./.exec(agent.rationale);
  if (momentum) return t("Synthetic closing prices moved {change}% over {count} sessions. The score moves with the strength and direction of that trend.", {
    change: decimal.format(Number(momentum[1])), count: momentum[2],
  });
  const error = /^The model provider returned HTTP (\d+)\.$/.exec(agent.rationale);
  return error ? t("The model provider returned HTTP {status}.", { status: error[1] }) : agent.rationale;
}

function Source({ source }) {
  const { language, t, dateLabel, money, signedPercent, shareCount } = useLanguage();
  const label = t(source.title) + (source.date ? " · " + dateLabel(source.date) : "");
  let data;
  if (source.id?.endsWith("-data")) {
    try { data = JSON.parse(source.text); } catch { /* Display the stored excerpt. */ }
  }
  let text = source.text;
  let original = false;
  if (data && typeof data === "object") {
    const entries = "from" in data ? [
      ["From", dateLabel(data.from)], ["As of", dateLabel(data.asOf)],
      ["First close", money.format(data.first)], ["Last close", money.format(data.last)],
      ["Change", signedPercent.format(data.change / 100)], ["Trading sessions", shareCount.format(data.sessions)],
    ] : [
      ["As of", data.as_of ? dateLabel(data.as_of) : "—"],
      ...[
        ["Cash", data.cash],
        ["Debt", data.longTermDebt ?? data.debt],
        ["Operating cash flow", data.operatingCashAnnual ?? data.operatingCash],
        ["Revenue", data.revenueAnnual ?? data.revenue],
      ].map(([key, value]) => {
        if (value?.period_end && Number.isFinite(value.value)) {
          return [key, money.format(value.value) + " (" + dateLabel(value.period_end) + ")"];
        }
        return [key, Number.isFinite(value) ? money.format(value) : "—"];
      }),
    ];
    text = entries.map(([key, value]) => t(key) + " " + value).join(" · ");
  } else if (language === "de") {
    const synthetic = /^Synthetic (\w+) example\. (.*)$/.exec(text);
    if (synthetic && !source.url) text = t("Synthetic {ticker} example.", { ticker: synthetic[1] }) + " " + synthetic[2].split(/(?<=\.) /).map(sentence => t(sentence)).join(" ");
    else original = true;
  }

  return <li>
    {source.url?.startsWith("https://") ? <a href={source.url} target="_blank" rel="noopener noreferrer">{label}</a> : <span>{label}</span>}
    {original && <small className="content-language">{t("Original excerpt in English")}</small>}
    <blockquote lang={original ? "en" : undefined}>{text}</blockquote>
  </li>;
}

function ScoreChange({ previous, current }) {
  const { t } = useLanguage();
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return <span className="comparison-change">
    {t(Number.isFinite(current) ? "Now scored" : Number.isFinite(previous) ? "Now unscored" : "Unscored")}
  </span>;
  const change = current - previous;
  const delta = change > 0 ? "+" + change : "−" + Math.abs(change);
  return <span className="comparison-change" data-direction={change ? (change > 0 ? "up" : "down") : undefined}>
    {change ? t(Math.abs(change) === 1 ? "{delta} point" : "{delta} points", { delta }) : t("No change")}
  </span>;
}

function Comparison({ result, history, onOpen }) {
  const { t, runDate } = useLanguage();
  const comparison = compareWithPrevious(result, history);
  const earlier = comparison?.previous;
  const scoreLabel = score => Number.isFinite(score) ? score + "/100" : t("Unscored");
  const rows = earlier ? [
    [t("Overall"), earlier.score, result.score, "overall"],
    ...comparison.agents.map(({ current, previous }, index) => [<AgentName agent={current} index={index} />, previous.score, current.score, current.id]),
  ] : [];

  return <details className="card comparison-card">
    <summary>{t("Compare with previous analysis")} <span className="comparison-summary">
      {earlier ? <ScoreChange previous={earlier.score} current={result.score} /> : t("No matching earlier run")}
    </span></summary>
    <div className="comparison-content">
      {!earlier ? <p>{t("Run another analysis for this stock with the same settings to compare results.")}</p> : <>
        <div className="comparison-header">
          <dl className="comparison-dates">{[["Earlier run", earlier], ["Current run", result]].map(([label, run]) =>
            <div key={label}><dt>{t(label)}</dt><dd><time dateTime={run.createdAt}>{runDate.format(new Date(run.createdAt))}</time></dd></div>
          )}</dl>
          <button type="button" className="secondary" onClick={() => onOpen(earlier)}>{t("Open earlier result")}</button>
        </div>
        <div className="overflow-x-auto">
          <table className="comparison-table" aria-label={t("Analysis score comparison")}>
            <thead><tr>{["Score", "Earlier", "Current", "Change"].map(label => <th key={label} scope="col">{t(label)}</th>)}</tr></thead>
            <tbody>{rows.map(([label, previous, current, id]) => <tr key={id}>
              <th scope="row">{label}</th><td>{scoreLabel(previous)}</td><td>{scoreLabel(current)}</td><td><ScoreChange previous={previous} current={current} /></td>
            </tr>)}</tbody>
          </table>
        </div>
        {comparison.agents.some(({ previous, current }) => Number.isFinite(previous.score) !== Number.isFinite(current.score)) &&
          <p>{t("Different agents contributed scores to the two totals.")}</p>}
        <div className="comparison-evidence">{[
          ["Newly cited sources", comparison.addedSources, "All cited sources already appeared in the earlier run."],
          ["Updated data snapshots", comparison.updatedSources, "Shared data snapshots are unchanged."],
        ].map(([title, sources, empty]) => <section key={title}>
          <h3>{t(title)}</h3>
          {sources.length ? <ul>{sources.map(source => <Source key={source.id} source={source} />)}</ul> : <p>{t(empty)}</p>}
        </section>)}</div>
      </>}
    </div>
  </details>;
}

export function AnalysisResult({ result, history, providers, actions, onOpen }) {
  const translation = useLanguage();
  const { t, language } = translation;
  const ref = useRef(null);
  const [, tone, title, , description] = outlook(result.score);
  const scored = result.agents.filter(agent => Number.isFinite(agent.score)).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const worst = scored.at(-1);

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [result.id]);

  return <section ref={ref} className="results" aria-labelledby="result-title">
    <header className="card result-summary" data-outlook={tone}>
      <div>
        <h2 id="result-title">{t("{ticker} · {range} outlook", { ticker: result.ticker, range: t(ranges[result.horizon]) })}</h2>
        <p className="result-meta">{[
          t(providers.find(provider => provider.id === result.provider)?.label ?? result.provider),
          t("{scored} of {total} agents scored", { scored: result.scoredAgents, total: result.agentCount }),
          result.min != null && t("Score range {min}–{max}", { min: result.min, max: result.max }),
          result.marketMode === "demo" && t("Synthetic evidence"),
        ].filter(Boolean).join(" · ")}</p>
        <p className="outlook-label">{t(title)}</p>
        <p className="result-explanation">{t(description)}{best?.score >= 65 && worst?.score < 45 && " " +
          t("Agents disagreed. {best} was favorable ({high}/100) and {worst} was unfavorable ({low}/100).", {
            best: t(best.name), high: best.score, worst: t(worst.name), low: worst.score,
          })}</p>
      </div>
      <div className="result-score"><ScoreRing score={result.score} /></div>
      <div className="result-actions"><StockActions {...actions} label="Analyzed stock actions" /></div>
      <details className="score-guide">
        <summary>{t("How to read the score")}</summary>
        <p>{t("The overall score averages the agents with usable results. The scale describes how the evidence leans over the selected time horizon.")}</p>
        <ul className="score-scale">{bands.map(([min, band, label], index) =>
          <li key={band} data-outlook={band}>{min}–{index ? bands[index - 1][0] - 1 : 100} {t(label)}</li>
        )}</ul>
        <p><a href="#disclosures-title">{t("Read the research disclosures")}</a></p>
      </details>
    </header>
    <Comparison result={result} history={history} onOpen={onOpen} />
    <div className="agent-results">{result.agents.map((agent, index) => {
      const [, agentTone, , label] = outlook(agent.score);
      const rationale = rationaleFor(agent, translation);
      const english = language === "de" && !agent.rationaleDe && rationale === agent.rationale;
      return <article key={agent.id} className="card agent-card">
        <header className="agent-heading"><h3><AgentName agent={agent} index={index} /></h3>
          <span className="agent-outlook" data-outlook={agentTone}>{t(label)}</span></header>
        <ScoreRing score={agent.score} />
        <div className="agent-evidence">
          {english && <small className="content-language">{t("English original")}</small>}
          <p lang={english ? "en" : undefined}>{rationale}</p>
          {agent.sources.length > 0 && <details><summary>{t(agent.sources.length === 1 ? "Source" : "{count} sources", { count: agent.sources.length })}</summary>
            <ul>{agent.sources.map(source => <Source key={source.id} source={source} />)}</ul>
          </details>}
        </div>
      </article>;
    })}</div>
  </section>;
}
