-- Takes the due JMAP Web Push checks (lib/jmap/push/delivery.js) out of the sorted set, so every check
-- is claimed by one worker only.
--
-- KEYS[1] sorted set of due checks
-- ARGV: latest time to claim (milliseconds), most members to claim

local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
if #due > 0 then
    redis.call('ZREM', KEYS[1], unpack(due))
end
return due
