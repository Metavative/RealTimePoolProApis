// src/services/redisPresence.js
import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
export const redis = new IORedis(REDIS_URL);

const PRESENCE_PREFIX = "presence:user:"; // key -> presence:user:<userId> => socketId
const PRESENCE_SET = "presence:users"; // optional set to list users

export async function setPresence(userId, socketId, ttlSeconds = 60 * 60 * 24) {
  if (!userId || !socketId) return;
  const key = PRESENCE_PREFIX + userId;
  await redis.set(key, socketId, "EX", ttlSeconds);
  await redis.sadd(PRESENCE_SET, userId);
}

export async function removePresence(userId) {
  if (!userId) return;
  const key = PRESENCE_PREFIX + userId;
  await redis.del(key);
  await redis.srem(PRESENCE_SET, userId);
}

export async function getSocketId(userId) {
  if (!userId) return null;
  return await redis.get(PRESENCE_PREFIX + userId);
}

export async function listOnlineUsers() {
  // returns array of userIds (strings)
  return await redis.smembers(PRESENCE_SET);
}
