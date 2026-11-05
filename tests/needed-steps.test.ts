// What a stopped setup tells you to do to let in the files its tests need.
import { expect, test } from "bun:test";
import { neededSteps } from "../src/cli";

test("a file faked in the sandbox is freed by allow-secret, not by .arnxignore", () => {
  expect(neededSteps([{ path: "tests/data/server.pem", secret: false, faked: true }]))
    .toEqual(["arnx allow-secret tests/data/server.pem"]);
});

test("a secret and a faked file share one allow-secret; an ignored one still goes in .arnxignore", () => {
  expect(neededSteps([{ path: "a.pem", secret: true }, { path: "b.pem", secret: false, faked: true },
    { path: "c.txt", secret: false }])).toEqual(["arnx allow-secret a.pem b.pem", "add !c.txt to .arnxignore"]);
});

test("a file only left out is still freed through .arnxignore", () => {
  expect(neededSteps([{ path: "c.txt", secret: false }])).toEqual(["add !c.txt to .arnxignore"]);
});
