// Bridge-safe scan entry points for the Python (JSPyBridge) bots. Everything
// here runs natively in Node: `team` arrives as a primitive, `bot.ctf` is
// constructed Node-side, and the bounded scans never call back into Python —
// otherwise the synchronous Python->Node call deadlocks on the callback.
const findArenaFlags = require('./arena-flag-search');
const findArenaGoals = require('./arena-goal-search');

module.exports = {
  flags(bot, blockId, team) {
    bot.ctf = { team };
    return findArenaFlags(bot, blockId);
  },
  goals(bot, team) {
    bot.ctf = { team };
    return findArenaGoals(bot);
  }
};
