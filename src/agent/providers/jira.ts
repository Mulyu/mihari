import type { ProviderSpec } from "./index.js";

export const jira: ProviderSpec = {
  name: "jira",
  requiredEnv: ["JIRA_BASE", "JIRA_USER", "JIRA_TOKEN"],
  preamble: `# Jira provider

Use the Jira REST v3 API via curl. JIRA_PROJECT is optional but is the
default project for new issues; pass it explicitly when creating tickets.

  curl -fsS -u "$JIRA_USER:$JIRA_TOKEN" \\
    -H 'Content-Type: application/json' \\
    "$JIRA_BASE/rest/api/3/<endpoint>"

Useful endpoints:
- GET  /rest/api/3/search?jql=<JQL>     — find tickets
- POST /rest/api/3/issue                — create a ticket
- POST /rest/api/3/issue/{key}/transitions   — transition (e.g. close) a ticket
- GET  /rest/api/3/issue/{key}/transitions   — list available transition ids

Idempotency:
- $MIHARI_IDEMPOTENCY_KEY is a deterministic 12-hex key for this trigger
  event. It is the same value across re-observations of the same event.
- Before creating a ticket, search for existing ones:
    GET /rest/api/3/search?jql=summary~"$MIHARI_IDEMPOTENCY_KEY"+AND+statusCategory!=Done
  If anything is returned, treat it as already-handled and skip.
- When creating a ticket, embed $MIHARI_IDEMPOTENCY_KEY in the summary
  AND attach a label "monitor:<id>" (or another stable selector) so a
  later transition (ok -> ...) can find and close the right ticket.`,
};
