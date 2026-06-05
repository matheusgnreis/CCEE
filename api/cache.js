// api/cache.js
// Redis cache com fallback em memória.
// Com REDIS_URL no .env → usa Redis (compartilhado entre processos/deploys).
// Sem REDIS_URL → Map em memória (suficiente para instância única).

let redis = null;
if (process.env.REDIS_URL) {
  try {
    const IORedis = require("ioredis");
    redis = new IORedis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
    redis.on("error", e => console.warn("[cache] Redis erro:", e.message));
  } catch (e) {
    console.warn("[cache] ioredis não disponível, usando memória:", e.message);
  }
}

const _map = new Map();

async function get(key) {
  try {
    if (redis) {
      const v = await redis.get(key);
      return v ? JSON.parse(v) : null;
    }
  } catch {}
  const e = _map.get(key);
  if (!e || e.exp < Date.now()) { _map.delete(key); return null; }
  return e.val;
}

async function set(key, val, ttlSec = 3600) {
  try {
    if (redis) {
      await redis.set(key, JSON.stringify(val), "EX", ttlSec);
      return;
    }
  } catch {}
  _map.set(key, { val, exp: Date.now() + ttlSec * 1000 });
}

async function del(pattern) {
  try {
    if (redis) {
      const keys = await redis.keys(pattern);
      if (keys.length) await redis.del(...keys);
      return;
    }
  } catch {}
  const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
  for (const k of _map.keys()) {
    if (k.startsWith(prefix)) _map.delete(k);
  }
}

// Helper para endpoints: busca cache, se miss executa fn(), salva e retorna.
async function cached(key, ttlSec, fn) {
  const hit = await get(key);
  if (hit !== null) return hit;
  const result = await fn();
  await set(key, result, ttlSec);
  return result;
}

module.exports = { get, set, del, cached };
