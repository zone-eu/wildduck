-- Reserves or releases part of a sliding window limit, on a key that ttlcounter.lua also reads and
-- increments (the daily recipient counter wdr:<user> is shared with the ZoneMTA plugin). The value is
-- a plain integer and the window starts with the first count, exactly as ttlcounter does it.
--
-- amount > 0: adds the amount only when the counter stays within the limit, atomically, so parallel
--             reservations can not pass the limit together. Returns {1, updated, ttl} or {0, current, ttl}.
-- amount <= 0: releases an earlier reservation. Never goes below zero and never creates the key, so a
--              release after the window ran out does not carry into the next window. Returns {1, updated, ttl}.

local key = KEYS[1];
local amount = tonumber(ARGV[1]) or 0;
local limit = tonumber(ARGV[2]) or 0;
local windowSize = tonumber(ARGV[3]) or 0;
local current = tonumber(redis.call("GET", key)) or 0;

if amount <= 0 then
    if current <= 0 then
        return {1, 0, tonumber(redis.call("TTL", key)) or 0};
    end;
    local updated = tonumber(redis.call("DECRBY", key, math.min(-amount, current)));
    return {1, updated, tonumber(redis.call("TTL", key)) or 0};
end;

if current + amount > limit then
    return {0, current, tonumber(redis.call("TTL", key)) or 0};
end;

local updated = tonumber(redis.call("INCRBY", key, amount));
-- a key without an expiry (a fresh one, or one left behind without a TTL) starts a new window
if current == 0 or tonumber(redis.call("TTL", key)) == -1 then
    redis.call("EXPIRE", key, windowSize);
end;

return {1, updated, tonumber(redis.call("TTL", key)) or 0};
