local currentVersion = redis.call('GET', KEYS[1]) or '0'

if currentVersion ~= ARGV[1] then
    return 0
end

redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
