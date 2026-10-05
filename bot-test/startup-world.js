// Gate the next login on loaded terrain and a quiet chunk stream. Fixed login
// spacing alone still overlaps slow Paper logins and Mineflayer chunk parsing.
module.exports = function waitForInitialWorld(bot, {
  timeoutMs = 30000, quietMs = 750, pollMs = 100, isStopping = () => false
} = {}) {
  return new Promise((resolve, reject) => {
    let spawned = false;
    let settled = false;
    let lastChunkAt = Date.now();
    const onSpawn = () => { spawned = true; lastChunkAt = Date.now(); };
    const onChunk = () => { lastChunkAt = Date.now(); };
    const onEnd = reason => finish(new Error(`disconnected during startup: ${reason || 'unknown'}`));
    const onError = error => finish(error);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      bot.off('spawn', onSpawn);
      bot.off('chunkColumnLoad', onChunk);
      bot.off('end', onEnd);
      bot.off('error', onError);
      if (error) reject(error);
      else resolve();
    }
    const deadline = setTimeout(() => finish(new Error('startup terrain did not become ready')), timeoutMs);
    const poll = setInterval(() => {
      if (isStopping()) return finish(new Error('startup cancelled'));
      if (!spawned || !bot.entity || !bot.world || Date.now() - lastChunkAt < quietMs) return;
      const cx = Math.floor(bot.entity.position.x / 16);
      const cz = Math.floor(bot.entity.position.z / 16);
      // Same 5x5 minimum as Mineflayer's waitForChunksToLoad, with a quiet
      // period to let the remaining view-distance chunks finish arriving.
      for (let x = cx - 2; x <= cx + 2; x++) {
        for (let z = cz - 2; z <= cz + 2; z++) {
          if (!bot.world.getColumn(x, z)) return;
        }
      }
      finish();
    }, pollMs);
    bot.on('spawn', onSpawn);
    bot.on('chunkColumnLoad', onChunk);
    bot.on('end', onEnd);
    bot.on('error', onError);
  });
};
