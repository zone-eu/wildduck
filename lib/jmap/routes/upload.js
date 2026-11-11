'use strict';

// POST /jmap/upload/{accountId}/ (RFC 8620 6.1). Uploads arrive in phase 2; until then the endpoint
// exists, authenticates like every other one, and answers 501 without reading or storing anything.

const { RequestProblem } = require('../errors');

module.exports = ({ route }) => {
    const upload = async () => {
        throw new RequestProblem('about:blank', 501, 'Uploads are not implemented yet');
    };
    route('/jmap/upload/:accountId', ['POST'], upload);
    route('/jmap/upload/:accountId/', ['POST'], upload);
};
