// RFC 9309 for the rules every crawler gets (User-agent: *): a robots.txt the server reports
// unavailable (4xx) allows every path, and one that cannot be read (429 or 5xx) disallows the site.
function robotsAllowed(status, body, url) {
  if (status === 429 || status >= 500) return false;
  if (status < 200 || status >= 300) return true;
  const normalize = value => {
    try {
      return encodeURI(decodeURI(value));
    } catch (err) {
      return value;
    }
  };
  const target = new URL(url);
  const path = normalize(target.pathname + target.search);
  const groups = [];
  let group = null;
  let inAgentLines = false;
  for (const raw of String(body || "").split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!inAgentLines) groups.push(group = { agents: [], rules: [] });
      group.agents.push(value.toLowerCase());
      inAgentLines = true;
    } else if ((key === "allow" || key === "disallow") && group) {
      group.rules.push({ allow: key === "allow", pattern: normalize(value) });
      inAgentLines = false;
    }
  }
  let best = null;
  for (const { agents, rules } of groups) {
    if (!agents.includes("*")) continue;
    for (const rule of rules) {
      if (!rule.pattern) continue;
      const anchored = rule.pattern.endsWith("$");
      const source = (anchored ? rule.pattern.slice(0, -1) : rule.pattern)
        .split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      if (!new RegExp("^" + source + (anchored ? "$" : "")).test(path)) continue;
      const length = rule.pattern.length;
      if (!best || length > best.length || (length === best.length && rule.allow)) best = { length, allow: rule.allow };
    }
  }
  return !best || best.allow;
}
