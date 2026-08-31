import { describe, expect, test } from "bun:test";
import { closingIssueNumbers } from "./close-delivered-issues";

describe("closingIssueNumbers", () => {
  test("extracts GitHub closing directives case-insensitively and deduplicates them", () => {
    expect(closingIssueNumbers("Closes #12; fixed #34; RESOLVE #12; fixes #56; close #78")).toEqual([
      12, 34, 56, 78,
    ]);
  });

  test("does not treat ordinary issue references as closing directives", () => {
    expect(closingIssueNumbers("Relates to #12, follows #34, and documents close #not-a-number.")).toEqual([]);
  });
});
