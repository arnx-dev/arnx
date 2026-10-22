const test = require("node:test");
const assert = require("node:assert");
const { priceTag } = require("../feed");

test("tags whole amounts", () => {
  assert.strictEqual(priceTag(1), "100 cents");
});
