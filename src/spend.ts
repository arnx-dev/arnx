// What the running command has spent on models so far, added as each billed reply arrives (the agent loop and the
// two JSON clients are the only places a reply is priced), for the live cost on the progress line.
export const spend = {
  total: 0,
  add(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.total += usd;
  },
};
