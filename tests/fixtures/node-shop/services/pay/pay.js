const { toCents } = require("../shared/money");

function charge(amount) {
  return { cents: toCents(amount) };
}

module.exports = { charge };
