'use strict';

const config = require('@zone-eu/wild-config');
const AccessControl = require('accesscontrol');
const ac = new AccessControl();

ac.setGrants(config.api.roles);

config.on('reload', () => {
    ac.setGrants(config.api.roles);
});

module.exports.can = role => ac.can(role);
