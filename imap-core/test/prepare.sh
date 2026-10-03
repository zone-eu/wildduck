#!/bin/bash

echo "which mongo"
which mongo

DBNAME="$1"
# API endpoint of the running test server, overridable so the suite can run on a non-default port
APIURL="http://127.0.0.1:${2:-8080}"

echo "Clearing DB"
mongosh "$DBNAME" --eval "db.getCollectionNames().forEach(function(key){db[key].deleteMany({});})" > /dev/null

echo "Creating user"
USERRESPONSE=`curl --silent -XPOST $APIURL/users \
-H 'Content-type: application/json' \
-d '{
  "username": "testuser",
  "password": "pass",
  "name": "Test User"
}'`
echo "UR: $USERRESPONSE"
USERID=`echo "$USERRESPONSE" | jq -r '.id'`

echo "Reading Mailbox ID"
MAILBOXLIST=`curl --silent "$APIURL/users/$USERID/mailboxes"`
echo "ML: $MAILBOXLIST"
echo "$MAILBOXLIST" | jq
INBOXID=`echo "$MAILBOXLIST" | jq -r '.results[0].id'`
SENTID=`echo "$MAILBOXLIST" | jq -r '.results[3].id'`

curl --silent -XPUT "$APIURL/users/$USERID/mailboxes/$SENTID" \
-H 'Content-type: application/json' \
-d '{
  "path": "[Gmail]/Sent Mail"
}'

MAILBOXLIST=`curl --silent "$APIURL/users/$USERID/mailboxes"`
echo "$MAILBOXLIST" | jq

curl --silent -XPOST "$APIURL/users/$USERID/mailboxes/$INBOXID/messages?date=14-Sep-2013%2021%3A22%3A28%20-0300&unseen=true" \
	-H 'Content-type: message/rfc822' \
	--data-binary "@fixtures/fix1.eml"

curl --silent -XPOST "$APIURL/users/$USERID/mailboxes/$INBOXID/messages?unseen=false" \
	-H 'Content-type: message/rfc822' \
	--data-binary "@fixtures/mimetorture.eml"

curl --silent -XPOST "$APIURL/users/$USERID/mailboxes/$INBOXID/messages?unseen=false" \
	-H 'Content-type: message/rfc822' \
	--data-binary "@fixtures/fix3.eml"

curl --silent -XPOST "$APIURL/users/$USERID/mailboxes/$INBOXID/messages?unseen=true" \
	-H 'Content-type: message/rfc822' \
	--data-binary "@fixtures/fix4.eml"

curl --silent -XPOST "$APIURL/users/$USERID/mailboxes/$INBOXID/messages?unseen=true" \
	-H 'Content-type: message/rfc822' \
	--data-binary "from: sender@example.com
to: receiver@example.com
subject: test5

hello 5
"

curl --silent -XPOST "$APIURL/users/$USERID/mailboxes/$INBOXID/messages?unseen=true" \
	-H 'Content-type: message/rfc822' \
	--data-binary "from: sender@example.com
to: receiver@example.com
subject: test6

hello 6
"

mongosh "$DBNAME" --eval "db.mailboxes.updateOne({_id: ObjectId('$INBOXID')}, {\$set:{modifyIndex: 5000, uidNext: 1000}});
db.messages.updateOne({mailbox: ObjectId('$INBOXID'), uid:1}, {\$set:{modseq: 100}});
db.messages.updateOne({mailbox: ObjectId('$INBOXID'), uid:2}, {\$set:{modseq: 5000}});
db.messages.updateMany({}, {\$inc:{uid: 100}});" > /dev/null

# curl --silent "$APIURL/users/$USERID/mailboxes/$INBOXID/messages" | jq
