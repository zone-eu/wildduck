-- Marks a JMAP Web Push check as due for a user that has a verified PushSubscription
-- (lib/jmap/push/delivery.js). Called by ImapNotifier.fire for every change notification, so for every
-- other user it is one set lookup. The first mark wins: changes until the check runs are folded in.
--
-- KEYS[1] set of the users with a verified subscription
-- KEYS[2] sorted set of due checks: member -> time of the first change (milliseconds)
-- ARGV: user id, member to add, time

if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
    redis.call('ZADD', KEYS[2], 'NX', ARGV[3], ARGV[2])
    return 1
end
return 0
