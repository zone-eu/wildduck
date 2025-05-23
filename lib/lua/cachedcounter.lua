local key = KEYS[1];
local increment = tonumber(ARGV[1]) or 0;
local ttl = tonumber(ARGV[2]) or 0;

if redis.call("EXISTS", key) == 1 then
    
    redis.call("INCRBY", key, increment);
    local sum = tonumber(redis.call("GET", key)) or 0;
    if sum < 0 then
        redis.call("DEL", key);
        sum = 0
    else
        -- extend the life of this counter by ttl seconds
        redis.call("EXPIRE", key, ttl);
    end
    
    return sum;
else
    return nil;
end
