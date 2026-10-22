// The base comparison's progress lines: what the failing and the passing tests did on the code before the change, in
// words (the statuses stay as they are in data and events).
import { expect, test } from "bun:test";
import { type Before, beforeStartText, beforeText, type Fix, fixText } from "../src/before";

const of = <S extends string>(...xs: [S, string?][]) => Object.fromEntries(xs.map(([status, detail], i) =>
  [`t${i}`, { status, detail: detail ?? "", runs: [] }])) as Record<string, { status: S; detail: string; runs: [] }>;

test("the start line names the kinds of tests that run", () => {
  expect(beforeStartText(4, 5)).toBe("running 4 failing and 5 passing tests on the code before the change");
  expect(beforeStartText(4, 0)).toBe("running 4 failing tests on the code before the change");
  expect(beforeStartText(0, 1)).toBe("running 1 passing test on the code before the change");
  expect(beforeStartText(1, 1)).toBe("running 1 failing and 1 passing tests on the code before the change");
});

test("one kind of outcome: a full sentence; the passing tests say 'either' after new-code failing tests", () => {
  const news = of<Before["status"]>(["new-code"], ["new-code"], ["new-code"], ["new-code"]);
  expect(beforeText(news)).toBe("the 4 failing tests cannot run there (what they test is new)");
  const fixNews = of<Fix["status"]>(["new-code"], ["new-code"], ["new-code"], ["new-code"], ["new-code"]);
  expect(fixText(fixNews, true)).toBe("the 5 passing tests cannot run there either, so they show no fix");
  expect(fixText(fixNews, false)).toBe("the 5 passing tests cannot run there (what they test is new), so they show no fix");
  expect(beforeText(of<Before["status"]>(["regression"]))).toBe("the failing test passes there: the change broke it");
  expect(fixText(of<Fix["status"]>(["fixed"], ["fixed"]), false))
    .toBe("the 2 passing tests fail there and pass now: the change fixes them");
  expect(fixText(of<Fix["status"]>(["unchanged"]), false)).toBe("the passing test passes there too");
});

test("several outcomes: one line per kind of test, joined with '; ', singular and plural right", () => {
  expect(beforeText(of<Before["status"]>(["regression"], ["regression"], ["pre-existing"], ["changed"], ["new-code"],
    ["unknown", "flaky on the code before the change (passed in 1 of 3 runs)"])))
    .toBe("2 failing tests pass there: the change broke them; 1 fails the same way there: not caused by the change; " +
      "1 cannot run there (what it tests is new); 1 fails differently there; 1 unclear (flaky)");
  expect(fixText(of<Fix["status"]>(["fixed"], ["unchanged"], ["unchanged"], ["new-code"], ["unknown"]), false))
    .toBe("1 passing test fails there and passes now: the change fixes it; 1 cannot run there (what it tests is new), " +
      "so it shows no fix; 2 pass there too; 1 unclear");
});

test("unclear: a short reason when there is one", () => {
  expect(beforeText(of<Before["status"]>(["unknown", "3 of 3 runs on the code before the change gave no report (3 timed out)"],
    ["unknown", "something else"]))).toBe("the 2 failing tests are unclear (timed out)");
  expect(beforeText(of<Before["status"]>(["unknown", "something else"]))).toBe("the failing test is unclear");
});
