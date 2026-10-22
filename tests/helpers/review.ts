import type { Finding, Review } from "../../src/report";

export const finding = (id: string, testId: string, func: string, file: string | null, message: string,
                        explanation: string, verdict: string | null = null, reason = ""): Finding =>
  ({ id, testId, func, file, message, explanation, verdict, reason, project: "main" });

/** The review used by the Python test_report.py. */
export function sampleReview(over: Partial<Review> = {}): Review {
  const r: Review = {
    id: "20261011-a1b2c3", change: "uncommitted (base 1a2b3c4)", filesChanged: 4, added: 140, removed: 3,
    reviewer: "anthropic:claude-sonnet-5-5", challenger: "openai:gpt-5.5-2026-04-23", promptVersion: "abc",
    findings: [
      finding("F1", "tests/g/test_i.py::test_member", "test_member", "app/tests/g/test_i.py",
        "Failed: DID NOT RAISE\nlong trace", "Any member can invite.", "confirmed", "No role check."),
      finding("F2", "tests/g/test_i.py::test_dup", "test_dup", "app/tests/g/test_i.py", "assert 2 == 1",
        "Duplicates.", "disputed", "Duplicates are allowed by design."),
    ],
    questions: ["Should invites expire?"], flaky: ["tests/g/test_i.py::test_slow"], errors: [], passed: 3,
    testsWritten: 6, missingRuns: 0, notSent: [".env.local"], costUsd: 0.34, seconds: 171.0, stop: "end_turn",
    writeDir: "app/tests/g", language: "python", projects: ["main"], notReviewed: [], uncovered: [],
    questionProjects: [], writeDirs: {}, projectStats: [], usage: [], groups: [], checked: [], ...over,
  };
  if (!over.questionProjects) r.questionProjects = r.questions.map(() => "main");
  if (!over.writeDirs) r.writeDirs = { main: r.writeDir };
  return r;
}

/** review.md with every pre-ticked "real" cleared, as review.md was before confirmed findings came pre-marked. */
export const blankMarks = (md: string) => md.replace(/^Mark: \[x\] real/gm, "Mark: [ ] real");
