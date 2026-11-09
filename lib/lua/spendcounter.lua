local key = KEYS[1];
local increment = tonumber(ARGV[1]) or 0;
local limit = tonumber(ARGV[2]) or 0;
local windowSize = tonumber(ARGV[3]) or 86400;
local current = tonumber(redis.call('GET', key)) or 0;
local ttl = redis.call('TTL', key);

-- Refused chunks do not spend the remaining allowance. This check and the
-- increment are atomic across every API worker and concurrent download.
if current >= limit or increment > limit - current then
    return {0, current, ttl};
end;

if increment > 0 then
    current = redis.call('INCRBY', key, increment);
    if ttl < 0 then
        redis.call('EXPIRE', key, windowSize);
    end;
    ttl = redis.call('TTL', key);
end;

return {1, current, ttl};
