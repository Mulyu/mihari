import type { AgentContext } from "../types/index.js";

const TEMPLATE_RE =
  /\{\{\s*(event\.line|event\.path|event\.timestamp|event\.log_stream|event\.monitor_id|event\.monitor_name|event\.alarm_name|event\.alarm_arn|event\.service|event\.host|event\.issue_key|event\.summary|event\.status|event\.severity|event\.resource_type|event\.run_id|event\.workflow_name|event\.branch|event\.conclusion|event\.html_url|event\.from_state|event\.to_state|env\.[A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function substituteTemplate(text: string, ctx: AgentContext): string {
  return text.replace(TEMPLATE_RE, (raw, key: string) => {
    if (key === "event.line") {
      if (ctx.event.type === "file") return ctx.event.content;
      if (ctx.event.type === "aws_cloudwatch_logs") return ctx.event.message;
      if (ctx.event.type === "datadog_log") return ctx.event.message;
      if (ctx.event.type === "gcp_cloud_logging") return ctx.event.message;
      return "";
    }
    if (key === "event.path") {
      if (ctx.event.type === "file") return ctx.event.path;
      if (ctx.event.type === "aws_cloudwatch_logs") return ctx.event.log_group;
      if (ctx.event.type === "datadog_log") return ctx.event.query;
      if (ctx.event.type === "gcp_cloud_logging") return ctx.event.log_name;
      return "";
    }
    if (key === "event.service") {
      return ctx.event.type === "datadog_log" ? ctx.event.service : "";
    }
    if (key === "event.host") {
      return ctx.event.type === "datadog_log" ? ctx.event.host : "";
    }
    if (key === "event.issue_key") {
      return ctx.event.type === "jira_issue" ? ctx.event.issue_key : "";
    }
    if (key === "event.summary") {
      return ctx.event.type === "jira_issue" ? ctx.event.summary : "";
    }
    if (key === "event.status") {
      return ctx.event.type === "jira_issue" ? ctx.event.status : "";
    }
    if (key === "event.severity") {
      return ctx.event.type === "gcp_cloud_logging" ? ctx.event.severity : "";
    }
    if (key === "event.resource_type") {
      return ctx.event.type === "gcp_cloud_logging" ? ctx.event.resource_type : "";
    }
    if (key === "event.run_id") {
      return ctx.event.type === "github_workflow_run" ? String(ctx.event.run_id) : "";
    }
    if (key === "event.workflow_name") {
      return ctx.event.type === "github_workflow_run" ? ctx.event.workflow_name : "";
    }
    if (key === "event.branch") {
      return ctx.event.type === "github_workflow_run" ? ctx.event.branch : "";
    }
    if (key === "event.conclusion") {
      return ctx.event.type === "github_workflow_run" ? ctx.event.conclusion : "";
    }
    if (key === "event.html_url") {
      return ctx.event.type === "github_workflow_run" ? ctx.event.html_url : "";
    }
    if (key === "event.timestamp") return ctx.event.timestamp;
    if (key === "event.log_stream") {
      return ctx.event.type === "aws_cloudwatch_logs" ? ctx.event.log_stream : "";
    }
    if (key === "event.monitor_id") {
      return ctx.event.type === "datadog_monitor" ? ctx.event.monitor_id : "";
    }
    if (key === "event.monitor_name") {
      return ctx.event.type === "datadog_monitor" ? ctx.event.monitor_name : "";
    }
    if (key === "event.alarm_name") {
      return ctx.event.type === "aws_cloudwatch_alarm" ? ctx.event.alarm_name : "";
    }
    if (key === "event.alarm_arn") {
      return ctx.event.type === "aws_cloudwatch_alarm" ? ctx.event.alarm_arn : "";
    }
    if (key === "event.from_state") {
      if (ctx.event.type === "datadog_monitor") return ctx.event.from_state;
      if (ctx.event.type === "aws_cloudwatch_alarm") return ctx.event.from_state;
      return "";
    }
    if (key === "event.to_state") {
      if (ctx.event.type === "datadog_monitor") return ctx.event.to_state;
      if (ctx.event.type === "aws_cloudwatch_alarm") return ctx.event.to_state;
      return "";
    }
    if (key.startsWith("env.")) return process.env[key.slice(4)] ?? "";
    return raw;
  });
}

export function captureStdout(stdout: string): string {
  return stdout.replace(/\n+$/, "");
}
