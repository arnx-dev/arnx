const test = require("node:test");
const assert = require("node:assert");
const { charge } = require("../pay");

test("charges whole amounts", () => {
  assert.strictEqual(charge(2).cents, 200);
});
