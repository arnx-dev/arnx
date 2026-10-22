// Prices are kept in cents.
function toCents(amount) {
  return Math.round(amount * 100);
}

module.exports = { toCents };
