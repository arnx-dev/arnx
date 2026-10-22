const { toCents } = require("../shared/money");

function priceTag(amount) {
  return `${toCents(amount)} cents`;
}

module.exports = { priceTag };
