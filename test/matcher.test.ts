import { describe, expect, it } from "vitest";
import {
  match,
  matchAwsCloudWatchAlarm,
  matchAwsCloudWatchLogs,
  matchDatadogLog,
  matchDatadogMonitor,
  matchGithubWorkflowRun,
  matchJiraIssue,
  matchSentryIssue,
  uniqueTriggerPaths,
} from "../src/engine/matcher.js";
import type {
  AwsCloudWatchAlarmState,
  DatadogMonitorState,
  Runbook,
  SentryIssueLevel,
  TriggerEvent,
} from "../src/types/index.js";
import { fakeAgent } from "./_fixtures.js";

function fileRb(id: string, path: string, pattern: RegExp): Runbook {
  return {
    id,
    trigger: { source: "file", path, pattern },
    agent: fakeAgent(),
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function cronRb(id: string, schedule: string): Runbook {
  return {
    id,
    trigger: { source: "cron", schedule },
    agent: fakeAgent(),
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function fileEvent(path: string, content: string): Extract<TriggerEvent, { type: "file" }> {
  return { type: "file", path, content, timestamp: "2026-04-26T00:00:00Z" };
}

describe("match", () => {
  it("returns runbooks whose trigger.path and pattern match", () => {
    const rbs = [
      fileRb("a", "/var/log/app.log", /ERROR/),
      fileRb("b", "/var/log/app.log", /WARN/),
      fileRb("c", "/var/log/other.log", /ERROR/),
    ];
    const m = match(fileEvent("/var/log/app.log", "ERROR: foo"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("returns multiple matches when several runbooks apply", () => {
    const rbs = [
      fileRb("a", "/var/log/app.log", /ERROR/),
      fileRb("b", "/var/log/app.log", /foo/),
    ];
    const m = match(fileEvent("/var/log/app.log", "ERROR foo"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a", "b"]);
  });

  it("normalizes paths", () => {
    const rbs = [fileRb("a", "/var/log/app.log", /x/)];
    const m = match(fileEvent("/var/log/./app.log", "x"), rbs);
    expect(m).toHaveLength(1);
  });

  it("ignores cron runbooks", () => {
    const rbs = [cronRb("c", "* * * * *"), fileRb("a", "/var/log/app.log", /x/)];
    const m = match(fileEvent("/var/log/app.log", "x"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });
});

function cwRb(
  id: string,
  region: string,
  group: string,
  pattern?: RegExp,
): Runbook {
  return {
    id,
    trigger: pattern
      ? { source: "aws_cloudwatch_logs", region, log_group: group, interval_sec: 60, pattern }
      : { source: "aws_cloudwatch_logs", region, log_group: group, interval_sec: 60 },
    agent: fakeAgent(),
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function cwEvent(
  region: string,
  group: string,
  message: string,
): Extract<TriggerEvent, { type: "aws_cloudwatch_logs" }> {
  return {
    type: "aws_cloudwatch_logs",
    region,
    log_group: group,
    log_stream: "s",
    message,
    event_id: "id1",
    timestamp: "2026-04-26T00:00:00Z",
    timestamp_ms: 0,
  };
}

describe("matchAwsCloudWatchLogs", () => {
  it("matches by region + log_group + pattern", () => {
    const rbs = [
      cwRb("a", "us-east-1", "/g", /ERROR/),
      cwRb("b", "us-east-1", "/g", /WARN/),
      cwRb("c", "us-east-1", "/h", /ERROR/),
      cwRb("d", "us-west-2", "/g", /ERROR/),
    ];
    const m = matchAwsCloudWatchLogs(cwEvent("us-east-1", "/g", "ERROR x"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("matches all events when pattern is omitted", () => {
    const rbs = [cwRb("a", "us-east-1", "/g")];
    const m = matchAwsCloudWatchLogs(cwEvent("us-east-1", "/g", "anything"), rbs);
    expect(m).toHaveLength(1);
  });

  it("ignores file/cron runbooks", () => {
    const rbs: Runbook[] = [
      fileRb("f", "/var/log/x", /./),
      cronRb("c", "* * * * *"),
      cwRb("a", "us-east-1", "/g"),
    ];
    const m = matchAwsCloudWatchLogs(cwEvent("us-east-1", "/g", "x"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });
});

function ddRb(
  id: string,
  site: string,
  monitorTags: string[] | undefined,
  transitions: DatadogMonitorState[],
): Runbook {
  const trigger: Runbook["trigger"] = {
    source: "datadog_monitors",
    site,
    transitions,
    interval_sec: 60,
  };
  if (monitorTags !== undefined) trigger.monitor_tags = monitorTags;
  return {
    id,
    trigger,
    agent: fakeAgent(),
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function ddEvent(
  site: string,
  monitorTags: string[],
  fromState: DatadogMonitorState,
  toState: DatadogMonitorState,
): Extract<TriggerEvent, { type: "datadog_monitor" }> {
  return {
    type: "datadog_monitor",
    site,
    monitor_tags: monitorTags,
    monitor_id: "1",
    monitor_name: "m1",
    from_state: fromState,
    to_state: toState,
    timestamp: "2026-05-09T12:00:00Z",
  };
}

describe("matchDatadogMonitor", () => {
  it("matches when site, sorted monitor_tags, and to_state ∈ transitions all align", () => {
    const rbs = [ddRb("a", "datadoghq.com", ["env:prod"], ["alert"])];
    const m = matchDatadogMonitor(ddEvent("datadoghq.com", ["env:prod"], "ok", "alert"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose site differs", () => {
    const rbs = [
      ddRb("a", "datadoghq.com", ["env:prod"], ["alert"]),
      ddRb("b", "datadoghq.eu", ["env:prod"], ["alert"]),
    ];
    const m = matchDatadogMonitor(ddEvent("datadoghq.com", ["env:prod"], "ok", "alert"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose monitor_tags differ", () => {
    const rbs = [
      ddRb("a", "datadoghq.com", ["env:prod"], ["alert"]),
      ddRb("b", "datadoghq.com", ["env:staging"], ["alert"]),
      ddRb("c", "datadoghq.com", undefined, ["alert"]),
    ];
    const m = matchDatadogMonitor(ddEvent("datadoghq.com", ["env:prod"], "ok", "alert"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("treats monitor_tags ordering as irrelevant", () => {
    const rbs = [ddRb("a", "datadoghq.com", ["service:web", "env:prod"], ["alert"])];
    const m = matchDatadogMonitor(
      ddEvent("datadoghq.com", ["env:prod", "service:web"], "ok", "alert"),
      rbs,
    );
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("treats undefined and [] monitor_tags as the same key", () => {
    const rbs = [ddRb("a", "datadoghq.com", undefined, ["alert"])];
    const m = matchDatadogMonitor(ddEvent("datadoghq.com", [], "ok", "alert"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose transitions list does not include to_state", () => {
    const rbs = [
      ddRb("a", "datadoghq.com", ["env:prod"], ["alert"]),
      ddRb("b", "datadoghq.com", ["env:prod"], ["warn"]),
    ];
    const m = matchDatadogMonitor(ddEvent("datadoghq.com", ["env:prod"], "ok", "alert"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("returns multiple matches when several runbooks subscribe to the same key with overlapping transitions", () => {
    const rbs = [
      ddRb("a", "datadoghq.com", ["env:prod"], ["alert", "warn"]),
      ddRb("b", "datadoghq.com", ["env:prod"], ["alert"]),
    ];
    const m = matchDatadogMonitor(ddEvent("datadoghq.com", ["env:prod"], "ok", "alert"), rbs);
    expect(m.map((x) => x.runbook.id).sort()).toEqual(["a", "b"]);
  });

  it("ignores file / cron / aws_cloudwatch_logs runbooks", () => {
    const rbs: Runbook[] = [
      fileRb("f", "/var/log/x", /./),
      cronRb("c", "* * * * *"),
      cwRb("w", "us-east-1", "/g"),
      ddRb("d", "datadoghq.com", ["env:prod"], ["alert"]),
    ];
    const m = matchDatadogMonitor(ddEvent("datadoghq.com", ["env:prod"], "ok", "alert"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["d"]);
  });
});

function cwAlarmRb(
  id: string,
  region: string,
  alarmNames: string[] | undefined,
  transitions: AwsCloudWatchAlarmState[],
): Runbook {
  const trigger: Runbook["trigger"] = {
    source: "aws_cloudwatch_alarms",
    region,
    transitions,
    interval_sec: 60,
  };
  if (alarmNames !== undefined) trigger.alarm_names = alarmNames;
  return {
    id,
    trigger,
    agent: fakeAgent(),
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function cwAlarmEvent(
  region: string,
  alarmNames: string[],
  fromState: AwsCloudWatchAlarmState,
  toState: AwsCloudWatchAlarmState,
): Extract<TriggerEvent, { type: "aws_cloudwatch_alarm" }> {
  return {
    type: "aws_cloudwatch_alarm",
    region,
    alarm_names: alarmNames,
    alarm_name: alarmNames[0] ?? "a1",
    alarm_arn: "arn:aws:cloudwatch:us-east-1:123:alarm:a1",
    from_state: fromState,
    to_state: toState,
    timestamp: "2026-05-09T12:00:00Z",
  };
}

describe("matchAwsCloudWatchAlarm", () => {
  it("matches when region, sorted alarm_names, and to_state ∈ transitions align", () => {
    const rbs = [cwAlarmRb("a", "us-east-1", ["db-cpu"], ["ALARM"])];
    const m = matchAwsCloudWatchAlarm(cwAlarmEvent("us-east-1", ["db-cpu"], "OK", "ALARM"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose region differs", () => {
    const rbs = [
      cwAlarmRb("a", "us-east-1", ["db-cpu"], ["ALARM"]),
      cwAlarmRb("b", "us-west-2", ["db-cpu"], ["ALARM"]),
    ];
    const m = matchAwsCloudWatchAlarm(cwAlarmEvent("us-east-1", ["db-cpu"], "OK", "ALARM"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("treats alarm_names ordering as irrelevant", () => {
    const rbs = [cwAlarmRb("a", "us-east-1", ["b", "a"], ["ALARM"])];
    const m = matchAwsCloudWatchAlarm(
      cwAlarmEvent("us-east-1", ["a", "b"], "OK", "ALARM"),
      rbs,
    );
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("treats undefined and [] alarm_names as the same key", () => {
    const rbs = [cwAlarmRb("a", "us-east-1", undefined, ["ALARM"])];
    const m = matchAwsCloudWatchAlarm(cwAlarmEvent("us-east-1", [], "OK", "ALARM"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose transitions do not include to_state", () => {
    const rbs = [
      cwAlarmRb("a", "us-east-1", ["db-cpu"], ["OK"]),
      cwAlarmRb("b", "us-east-1", ["db-cpu"], ["ALARM"]),
    ];
    const m = matchAwsCloudWatchAlarm(cwAlarmEvent("us-east-1", ["db-cpu"], "OK", "ALARM"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["b"]);
  });

  it("ignores other trigger sources", () => {
    const rbs: Runbook[] = [
      fileRb("f", "/var/log/x", /./),
      cronRb("c", "* * * * *"),
      cwAlarmRb("a", "us-east-1", ["db-cpu"], ["ALARM"]),
    ];
    const m = matchAwsCloudWatchAlarm(cwAlarmEvent("us-east-1", ["db-cpu"], "OK", "ALARM"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });
});

function ddLogRb(id: string, site: string, query: string): Runbook {
  return {
    id,
    trigger: { source: "datadog_logs", site, query, interval_sec: 60 },
    agent: fakeAgent(),
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function ddLogEvent(
  site: string,
  query: string,
): Extract<TriggerEvent, { type: "datadog_log" }> {
  return {
    type: "datadog_log",
    site,
    query,
    log_id: "log1",
    service: "svc",
    host: "h1",
    message: "boom",
    timestamp: "2026-05-09T12:00:00Z",
    timestamp_ms: 0,
  };
}

describe("matchDatadogLog", () => {
  it("matches by site + query exactly", () => {
    const rbs = [ddLogRb("a", "datadoghq.com", "service:web status:error")];
    const m = matchDatadogLog(ddLogEvent("datadoghq.com", "service:web status:error"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose site differs", () => {
    const rbs = [
      ddLogRb("a", "datadoghq.com", "service:web"),
      ddLogRb("b", "datadoghq.eu", "service:web"),
    ];
    const m = matchDatadogLog(ddLogEvent("datadoghq.com", "service:web"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose query differs", () => {
    const rbs = [
      ddLogRb("a", "datadoghq.com", "service:web"),
      ddLogRb("b", "datadoghq.com", "service:api"),
    ];
    const m = matchDatadogLog(ddLogEvent("datadoghq.com", "service:web"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("ignores other trigger sources", () => {
    const rbs: Runbook[] = [
      fileRb("f", "/var/log/x", /./),
      cwRb("w", "us-east-1", "/g"),
      ddLogRb("a", "datadoghq.com", "service:web"),
    ];
    const m = matchDatadogLog(ddLogEvent("datadoghq.com", "service:web"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });
});

function jiraRb(id: string, base: string, jql: string): Runbook {
  return {
    id,
    trigger: { source: "jira_search", base, jql, interval_sec: 60 },
    agent: fakeAgent(),
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function jiraEvent(
  base: string,
  jql: string,
): Extract<TriggerEvent, { type: "jira_issue" }> {
  return {
    type: "jira_issue",
    base,
    jql,
    issue_key: "PROJ-1",
    summary: "x",
    status: "Open",
    updated: "2026-05-09T12:00:00Z",
    updated_ms: 0,
    timestamp: "2026-05-09T12:00:00Z",
  };
}

describe("matchJiraIssue", () => {
  it("matches by base + jql exactly", () => {
    const rbs = [jiraRb("a", "https://x.atlassian.net", "project = PROJ")];
    const m = matchJiraIssue(jiraEvent("https://x.atlassian.net", "project = PROJ"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose base differs", () => {
    const rbs = [
      jiraRb("a", "https://x.atlassian.net", "project = PROJ"),
      jiraRb("b", "https://y.atlassian.net", "project = PROJ"),
    ];
    const m = matchJiraIssue(jiraEvent("https://x.atlassian.net", "project = PROJ"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose jql differs (string equality, no normalization)", () => {
    const rbs = [
      jiraRb("a", "https://x.atlassian.net", "project = PROJ"),
      jiraRb("b", "https://x.atlassian.net", "project=PROJ"),
    ];
    const m = matchJiraIssue(jiraEvent("https://x.atlassian.net", "project = PROJ"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("ignores other trigger sources", () => {
    const rbs: Runbook[] = [
      cronRb("c", "* * * * *"),
      jiraRb("a", "https://x.atlassian.net", "project = PROJ"),
    ];
    const m = matchJiraIssue(jiraEvent("https://x.atlassian.net", "project = PROJ"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });
});

function ghRb(
  id: string,
  repo: string,
  conclusions: string[],
  branch?: string,
  workflows?: string[],
): Runbook {
  const trigger: Runbook["trigger"] = {
    source: "github_workflow_runs",
    repo,
    conclusions,
    interval_sec: 60,
  };
  if (branch !== undefined) trigger.branch = branch;
  if (workflows !== undefined) trigger.workflows = workflows;
  return {
    id,
    trigger,
    agent: fakeAgent(),
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function ghEvent(
  repo: string,
  branch: string,
  workflowName: string,
  workflowPath: string,
  conclusion: string,
): Extract<TriggerEvent, { type: "github_workflow_run" }> {
  return {
    type: "github_workflow_run",
    repo,
    run_id: 1,
    run_number: 1,
    workflow_name: workflowName,
    workflow_path: workflowPath,
    branch,
    conclusion,
    status: "completed",
    html_url: "https://github.com/x/y/actions/runs/1",
    timestamp: "2026-05-09T12:00:00Z",
  };
}

describe("matchGithubWorkflowRun", () => {
  it("matches when repo + conclusion align (branch / workflows unset)", () => {
    const rbs = [ghRb("a", "owner/repo", ["failure"])];
    const m = matchGithubWorkflowRun(
      ghEvent("owner/repo", "main", "CI", ".github/workflows/ci.yml", "failure"),
      rbs,
    );
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose repo differs", () => {
    const rbs = [
      ghRb("a", "owner/repo", ["failure"]),
      ghRb("b", "owner/other", ["failure"]),
    ];
    const m = matchGithubWorkflowRun(
      ghEvent("owner/repo", "main", "CI", ".github/workflows/ci.yml", "failure"),
      rbs,
    );
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose branch differs (when set)", () => {
    const rbs = [
      ghRb("a", "owner/repo", ["failure"], "main"),
      ghRb("b", "owner/repo", ["failure"], "develop"),
    ];
    const m = matchGithubWorkflowRun(
      ghEvent("owner/repo", "main", "CI", ".github/workflows/ci.yml", "failure"),
      rbs,
    );
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("matches workflows by full path, slug, or display name", () => {
    const byPath = ghRb("p", "owner/repo", ["failure"], undefined, [
      ".github/workflows/ci.yml",
    ]);
    const bySlug = ghRb("s", "owner/repo", ["failure"], undefined, ["ci.yml"]);
    const byName = ghRb("n", "owner/repo", ["failure"], undefined, ["CI"]);
    const noMatch = ghRb("x", "owner/repo", ["failure"], undefined, ["release.yml"]);
    const rbs = [byPath, bySlug, byName, noMatch];
    const m = matchGithubWorkflowRun(
      ghEvent("owner/repo", "main", "CI", ".github/workflows/ci.yml", "failure"),
      rbs,
    );
    expect(m.map((x) => x.runbook.id).sort()).toEqual(["n", "p", "s"]);
  });

  it("filters out runbooks whose conclusions do not include event.conclusion", () => {
    const rbs = [
      ghRb("a", "owner/repo", ["success"]),
      ghRb("b", "owner/repo", ["failure"]),
    ];
    const m = matchGithubWorkflowRun(
      ghEvent("owner/repo", "main", "CI", ".github/workflows/ci.yml", "failure"),
      rbs,
    );
    expect(m.map((x) => x.runbook.id)).toEqual(["b"]);
  });

  it("ignores other trigger sources", () => {
    const rbs: Runbook[] = [
      fileRb("f", "/var/log/x", /./),
      ghRb("a", "owner/repo", ["failure"]),
    ];
    const m = matchGithubWorkflowRun(
      ghEvent("owner/repo", "main", "CI", ".github/workflows/ci.yml", "failure"),
      rbs,
    );
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });
});

function sentryRb(
  id: string,
  base: string,
  organization: string,
  project: string,
  levels: SentryIssueLevel[],
): Runbook {
  return {
    id,
    trigger: {
      source: "sentry_issues",
      base,
      organization,
      project,
      levels,
      interval_sec: 60,
    },
    agent: fakeAgent(),
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function sentryEvent(
  base: string,
  organization: string,
  project: string,
  level: SentryIssueLevel,
  isNew = true,
): Extract<TriggerEvent, { type: "sentry_issue" }> {
  return {
    type: "sentry_issue",
    base,
    organization,
    project,
    issue_id: "1",
    short_id: "PROJ-1",
    title: "x",
    level,
    status: "unresolved",
    permalink: "https://sentry.example/issues/1/",
    first_seen: "2026-05-09T11:00:00Z",
    last_seen: "2026-05-09T12:00:00Z",
    is_new: isNew,
    timestamp: "2026-05-09T12:00:00Z",
  };
}

describe("matchSentryIssue", () => {
  it("matches when base + org + project + level all align", () => {
    const rbs = [
      sentryRb("a", "https://sentry.example", "org1", "p1", ["error", "fatal"]),
    ];
    const m = matchSentryIssue(
      sentryEvent("https://sentry.example", "org1", "p1", "error"),
      rbs,
    );
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose organization differs", () => {
    const rbs = [
      sentryRb("a", "https://sentry.example", "org1", "p1", ["error"]),
      sentryRb("b", "https://sentry.example", "org2", "p1", ["error"]),
    ];
    const m = matchSentryIssue(
      sentryEvent("https://sentry.example", "org1", "p1", "error"),
      rbs,
    );
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose project differs", () => {
    const rbs = [
      sentryRb("a", "https://sentry.example", "org1", "p1", ["error"]),
      sentryRb("b", "https://sentry.example", "org1", "p2", ["error"]),
    ];
    const m = matchSentryIssue(
      sentryEvent("https://sentry.example", "org1", "p1", "error"),
      rbs,
    );
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose levels do not include event.level", () => {
    const rbs = [
      sentryRb("a", "https://sentry.example", "org1", "p1", ["warning"]),
      sentryRb("b", "https://sentry.example", "org1", "p1", ["error", "fatal"]),
    ];
    const m = matchSentryIssue(
      sentryEvent("https://sentry.example", "org1", "p1", "error"),
      rbs,
    );
    expect(m.map((x) => x.runbook.id)).toEqual(["b"]);
  });

  it("ignores other trigger sources", () => {
    const rbs: Runbook[] = [
      cronRb("c", "* * * * *"),
      sentryRb("a", "https://sentry.example", "org1", "p1", ["error"]),
    ];
    const m = matchSentryIssue(
      sentryEvent("https://sentry.example", "org1", "p1", "error"),
      rbs,
    );
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });
});

describe("uniqueTriggerPaths", () => {
  it("deduplicates and resolves, ignoring cron", () => {
    const rbs = [
      fileRb("a", "/var/log/app.log", /x/),
      fileRb("b", "/var/log/./app.log", /y/),
      fileRb("c", "/var/log/other.log", /z/),
      cronRb("d", "* * * * *"),
    ];
    expect(uniqueTriggerPaths(rbs).sort()).toEqual([
      "/var/log/app.log",
      "/var/log/other.log",
    ]);
  });
});
