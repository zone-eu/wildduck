-- Stores the result list of a JMAP query state (lib/jmap/query-cache.js) in the hash of its user,
-- within a byte and entry budget per user. The oldest stored states are dropped first.
--
-- KEYS[1] hash: state -> list, plus the field "#" with the bytes held
-- KEYS[2] sorted set: state -> time it was last stored (milliseconds)
-- ARGV: state, list, complete (1/0), ttl (seconds), byte budget, entry budget, now (milliseconds)

local hash = KEYS[1]
local order = KEYS[2]
local field = ARGV[1]
local value = ARGV[2]
local complete = ARGV[3] == '1'
local ttl = tonumber(ARGV[4])
local budget = tonumber(ARGV[5])
local maxEntries = tonumber(ARGV[6])
local now = tonumber(ARGV[7])

local total = tonumber(redis.call('HGET', hash, '#') or '0') or 0

local function drop(state)
    local size = redis.call('HSTRLEN', hash, state)
    if size > 0 then
        total = total - size - string.len(state)
    end
    redis.call('HDEL', hash, state)
    redis.call('ZREM', order, state)
end

-- states older than the time to live, a bounded number per call
for _, state in ipairs(redis.call('ZRANGEBYSCORE', order, '-inf', now - ttl * 1000, 'LIMIT', 0, 64)) do
    drop(state)
end

-- an entry already holding a longer list is kept: both were read at the same state, so the shorter
-- one is a prefix of the longer one
local existing = redis.call('HSTRLEN', hash, field)
local length = string.len(value)
if existing < length or (existing == length and complete) then
    redis.call('HSET', hash, field, value)
    if existing > 0 then
        total = total + length - existing
    else
        total = total + length + string.len(field)
    end
end
redis.call('ZADD', order, now, field)

while total > budget or redis.call('ZCARD', order) > maxEntries do
    local oldest = redis.call('ZRANGE', order, 0, 0)[1]
    if not oldest or oldest == field then
        break
    end
    drop(oldest)
end

if total < 0 then
    total = 0
end
redis.call('HSET', hash, '#', total)
redis.call('EXPIRE', hash, ttl)
redis.call('EXPIRE', order, ttl)
return total
