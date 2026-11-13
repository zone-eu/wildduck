'use strict';

// The only routes an MCP credential may reach, by route name and method. Read routes map to
// the resource whose field allowlist shapes the response. Writes require their own grant.
const routes = new Map([
    ['getuser', { method: 'GET', resource: 'users' }],

    ['getuseraddresses', { method: 'GET', resource: 'addresses' }],
    ['getuseraddress', { method: 'GET', resource: 'addresses' }],
    ['getuseraddressregister', { method: 'GET', resource: 'addresses' }],
    ['createuseraddress', { method: 'POST', resource: 'addresses', action: 'createOwn' }],
    ['updateuseraddress', { method: 'PUT', resource: 'addresses', action: 'updateOwn' }],
    ['deleteuseraddress', { method: 'DELETE', resource: 'addresses', action: 'deleteOwn' }],
    ['updateaddressaddressregister', { method: 'PUT', resource: 'addresses', action: 'createOwn' }],

    ['getmailboxes', { method: 'GET', resource: 'mailboxes' }],
    ['getmailbox', { method: 'GET', resource: 'mailboxes' }],
    ['createmailbox', { method: 'POST', resource: 'mailboxes', action: 'createOwn' }],
    ['updatemailbox', { method: 'PUT', resource: 'mailboxes', action: 'updateOwn' }],
    ['deletemailbox', { method: 'DELETE', resource: 'mailboxes', action: 'deleteOwn' }],

    ['getuserlabels', { method: 'GET', resource: 'labels', listKey: 'labels' }],
    ['getlabel', { method: 'GET', resource: 'labels' }],
    ['getlabelcounters', { method: 'GET', resource: 'labels' }],
    ['createlabel', { method: 'POST', resource: 'labels', action: 'createOwn' }],
    ['renamelabel', { method: 'PUT', resource: 'labels', action: 'updateOwn' }],
    ['deletelabel', { method: 'DELETE', resource: 'labels', action: 'deleteOwn' }],

    ['getmessages', { method: 'GET', resource: 'messages' }],
    ['getmessage', { method: 'GET', resource: 'messages' }],
    ['searchmessages', { method: 'GET', resource: 'messages' }],
    ['getflagcounters', { method: 'GET', resource: 'messages' }],
    ['getflaggedcounter', { method: 'GET', resource: 'messages' }],
    ['getmessagesource', { method: 'GET', resource: 'messages' }],
    ['getmessageattachment', { method: 'GET', resource: 'attachments' }],
    ['updatemessagepathparams', { method: 'PUT', resource: 'messages', action: 'updateOwn' }],
    ['updatemessage', { method: 'PUT', resource: 'messages', action: 'updateOwn' }],
    ['searchapplymessages', { method: 'POST', resource: 'messages', action: 'updateOwn' }],
    ['deletemessage', { method: 'DELETE', resource: 'messages', action: 'deleteOwn' }],
    ['deletemessagesinmailbox', { method: 'DELETE', resource: 'messages', action: 'deleteOwn' }],
    ['uploadmessage', { method: 'POST', resource: 'messages', action: 'createOwn' }],
    ['forwardstoredmessage', { method: 'POST', resource: 'messages', action: 'createOwn', levels: ['mcp:send'] }],
    ['submitstoredmessage', { method: 'POST', resource: 'messages', action: 'createOwn', levels: ['mcp:send'] }],
    ['updateoutboundmessage', { method: 'PUT', resource: 'messages', action: 'updateOwn', levels: ['mcp:send'] }],
    ['deleteoutboundmessage', { method: 'DELETE', resource: 'messages', action: 'deleteOwn' }],

    ['getfilters', { method: 'GET', resource: 'filters' }],
    ['createfilter', { method: 'POST', resource: 'filters', action: 'createOwn' }],
    ['getfilter', { method: 'GET', resource: 'filters' }],
    ['updatefilter', { method: 'PUT', resource: 'filters', action: 'updateOwn' }],
    ['deletefilter', { method: 'DELETE', resource: 'filters', action: 'deleteOwn' }],

    ['getautoreply', { method: 'GET', resource: 'autoreplies' }],
    ['updateautoreply', { method: 'PUT', resource: 'autoreplies', action: 'updateOwn' }],
    ['deleteautoreply', { method: 'DELETE', resource: 'autoreplies', action: 'deleteOwn' }]
]);

module.exports = routes;
