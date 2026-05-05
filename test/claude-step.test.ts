import { describe, expect, it } from "vitest";
import { matchesAllowedTools } from "../src/steps/claude-step.js";

describe("matchesAllowedTools", () => {
  it("matches plain tool names", () => {
    expect(matchesAllowedTools("Read", {}, ["Read", "Edit"])).toBe(true);
    expect(matchesAllowedTools("Write", {}, ["Read", "Edit"])).toBe(false);
  });

  it("matches Bash with exact command", () => {
    expect(
      matchesAllowedTools("Bash", { command: "git status" }, ["Bash(git status)"]),
    ).toBe(true);
    expect(
      matchesAllowedTools("Bash", { command: "git status -s" }, ["Bash(git status)"]),
    ).toBe(false);
  });

  it("matches Bash with prefix wildcard", () => {
    const patterns = ["Bash(git push:*)"];
    expect(matchesAllowedTools("Bash", { command: "git push" }, patterns)).toBe(true);
    expect(matchesAllowedTools("Bash", { command: "git push origin main" }, patterns)).toBe(true);
    expect(matchesAllowedTools("Bash", { command: "git pushorigin" }, patterns)).toBe(false);
    expect(matchesAllowedTools("Bash", { command: "git pull" }, patterns)).toBe(false);
  });

  it("Bash patterns do not match other tool names", () => {
    expect(
      matchesAllowedTools("Edit", { command: "git status" }, ["Bash(git status)"]),
    ).toBe(false);
  });

  it("missing command on Bash never matches a Bash() pattern", () => {
    expect(matchesAllowedTools("Bash", {}, ["Bash(git status)"])).toBe(false);
  });

  it("returns false for empty pattern list", () => {
    expect(matchesAllowedTools("Read", {}, [])).toBe(false);
  });
});
