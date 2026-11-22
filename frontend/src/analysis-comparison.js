const matchingFields = ["ticker", "horizon", "provider", "model", "marketMode", "scoringVersion"];

function previousAnalysis(current, history) {
  const currentTime = Date.parse(current.createdAt);
  let latestTime = -Infinity;
  let previous;
  for (const candidate of history) {
    const time = Date.parse(candidate.createdAt);
    if (!(time < currentTime && time > latestTime)) continue;
    if (!matchingFields.every(key => (candidate[key] ?? null) === (current[key] ?? null))) continue;
    const agentIds = new Set(candidate.agents.map(agent => agent.id));
    if (candidate.agents.length !== current.agents.length || !current.agents.every(agent => agentIds.has(agent.id))) continue;
    previous = candidate;
    latestTime = time;
  }
  return previous;
}

function evidenceBySource(agents) {
  const entries = new Map();
  for (const agent of agents) {
    for (const source of agent.sources) {
      const snapshot = source.id?.endsWith("-data");
      const key = snapshot ? "snapshot:" + source.id : "source:" + (source.url || source.id);
      if (!entries.has(key)) entries.set(key, { source, snapshot });
    }
  }
  return entries;
}

function snapshotText(text) {
  try {
    return JSON.stringify(JSON.parse(text), (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
        : value
    );
  } catch {
    return text;
  }
}

export function compareWithPrevious(current, history) {
  const previous = previousAnalysis(current, history);
  if (!previous) return null;

  const previousAgents = new Map(previous.agents.map(agent => [agent.id, agent]));
  const agents = current.agents.map(agent => ({ current: agent, previous: previousAgents.get(agent.id) }));
  const earlierEvidence = evidenceBySource(previous.agents);
  const addedSources = [];
  const updatedSources = [];
  for (const [key, { source, snapshot }] of evidenceBySource(current.agents)) {
    const earlier = earlierEvidence.get(key)?.source;
    if (!earlier) addedSources.push(source);
    else if (snapshot && (source.date !== earlier.date || snapshotText(source.text) !== snapshotText(earlier.text))) updatedSources.push(source);
  }
  return { previous, agents, addedSources, updatedSources };
}
