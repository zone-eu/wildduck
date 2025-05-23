local key = KEYS[1];
local increment = tonumber(ARGV[1]) or 0;
local ttl = tonumber(ARGV[2]) or 0;

if redis.call("EXISTS", key) == 1 then
    
    redis.call("INCRBY", key, increment);
    local sum = tonumber(redis.call("GET", key)) or 0;
    if sum < 0 then
        redis.call("DEL", key);
        return nil;
    end

    -- extend the life of this counter by ttl seconds
    redis.call("EXPIRE", key, ttl);

    return sum;
else
    return nil;
end
