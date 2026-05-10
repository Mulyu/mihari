import type { ProviderSpec } from "./index.js";

export const slack: ProviderSpec = {
  name: "slack",
  requiredEnv: ["SLACK_WEBHOOK_URL"],
  preamble: `# Slack provider

Use the Slack incoming webhook via curl. The webhook URL itself carries
the auth, so do not add any additional Authorization header.

  curl -fsS -X POST \\
    -H 'Content-Type: application/json' \\
    -d '{"text": "..."}' \\
    "$SLACK_WEBHOOK_URL"

Send a single message per logical event. Quote any user-controlled
content (event.line, event.message, event.monitor_name) so that special
characters survive the JSON encoding — prefer constructing the JSON via
\`jq -n --arg text "$msg" '{text:$text}'\` when the message contains
arbitrary text.`,
};
