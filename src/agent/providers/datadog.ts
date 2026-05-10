import type { ProviderSpec } from "./index.js";

export const datadog: ProviderSpec = {
  name: "datadog",
  requiredEnv: ["DD_API_KEY", "DD_APP_KEY", "DD_SITE"],
  preamble: `# Datadog provider

Use the Datadog API directly via curl. Authentication comes from the
environment, not from arguments you must inspect:

  curl -fsS \\
    -H "DD-API-KEY: $DD_API_KEY" \\
    -H "DD-APPLICATION-KEY: $DD_APP_KEY" \\
    "https://api.$DD_SITE/api/v1/<endpoint>"

Useful endpoints:
- GET  /api/v1/monitor/<id>            — monitor definition + current state
- GET  /api/v1/events?...               — events stream around an incident
- POST /api/v1/query                    — metric queries (synthesize ?query=)
- GET  /api/v1/monitor/<id>/downtime    — active downtimes for a monitor

The trigger event already contains monitor_id / monitor_name /
from_state / to_state / monitor_tags, so you only need to call the API
when you want extra context (current value, related events, query text).`,
};
