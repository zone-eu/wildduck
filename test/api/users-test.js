/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

const os = require('os');

describe('API Users', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user, user2, token;

    it('should POST /users expect success', async () => {
        const response = await server
            .post('/users')
            .send({
                username: 'myuser2',
                name: 'John Smith',
                address: 'john@example.com',
                password: 'secretvalue',
                hashedPassword: false,
                emptyAddress: false,
                language: 'et',
                retention: 0,
                targets: ['user@example.com', 'https://example.com/upload/email'],
                spamLevel: 50,
                quota: 1073741824,
                recipients: 2000,
                forwards: 2000,
                requirePasswordChange: false,
                imapMaxUpload: 5368709120,
                imapMaxDownload: 21474836480,
                pop3MaxDownload: 21474836480,
                pop3MaxMessages: 300,
                imapMaxConnections: 15,
                receivedMax: 60,
                fromWhitelist: ['user@alternative.domain', '*@example.com'],
                tags: ['status:user', 'account:example.com'],
                addTagsToAddress: false,
                uploadSentMessages: false,
                mailboxes: {
                    sent: 'Saadetud kirjad',
                    trash: 'Prügikast',
                    junk: 'Praht',
                    drafts: 'Mustandid'
                },
                disabledScopes: ['imap', 'pop3', 'smtp'],
                metaData: {
                    accountIcon: 'avatar.png'
                },
                internalData: {
                    inTrial: true
                },
                pubKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nxsBNBGmoM3UBCAC19FO8c9Wfgsr6hJll/JbM3q+bDQ/Bb+t9kLxHdfae6bRZ\nfAm0wgpI0yYNrI2OlAbq7Ax6T7y9ULzDl4KC0eVJUEfhwQAaxXUbdOhhZ/5G\n66c8JcBYouJcQLu1RZ9KV7/HcJ28vH0tEYw8/wB81l8RHMwsR1wFt0oz1qnI\nQo76f87EHv751MveG5Dt+s7GEJ569YIZQZYjE5ssBPJoZT7MzhxBj7tKyvv+\nOYC4DVy9lBn9yUE0fRc5HcxfrF98oJp9A9E67heUU9XBav9oryUOvMeRcm8Z\nyG6RvVG9vcvyOOC+xB5rtJWUxcKQJY5ehr5+gUBZy/aZ8afL3kNorUF5ABEB\nAAHNH1dpbGQgRHVjayA8dGVzdEB3aWxkZHVjay5lbWFpbD7CwIoEEAEIAD4F\ngmmoM3UECwkHCAmQJjX094XgEEUDFQgKBBYAAgECGQECmwMCHgEWIQTSj6BP\nf7Fss07AItAmNfT3heAQRQAABUIH/jw29K6Ed1eS9f9YcSQvrqMrwE2dE9O6\nGXYfXeEK3BTpTpYuz9/X1SNP9pIFrIbHCTsyv/oMfoIhjf4vz1DTzxfmvWQe\nLk+jwkT2oRMH9D6MBHNH35YkWCgSxbSoehLr9e4vAC1ePW6tPAOTr5yuJHql\njn+hMJ3ZLYkNcQjUqkhmvT+uUrsQkVeUBjHzrc7LomfPxgMnaRO6MGtw1iDq\n00lIq5weF4yO8zK796hWk1QXtzddX4QpEIwpKrGkyqlz66cQDBU/DJEanTuV\nxDiyma+uhrN2rOOxy8cuMJICwSWgXndEmToVpAyB5Fu2YmtPsUqXACFB+l7U\nWghE5tOgQAjOwE0EaagzdQEIAIqGzI69Sx+cWbAbwEf4x9J9H4T+Z5K6e/I1\nmNXMA5lTnXus81j7SMqFS7rF+RXnSC9QLyuctkqv0bCr/Uhzb2Dy6BF5SY09\njNwTg8snB5xLbWoG11o1UsVGyZ3invdRaym6qcdGEPpFwzy4CZDF8oAbaOfd\nBQTblTmxb9EyX0fYmONSrHfEPh8MY3mXr9Mg1aA3c2l4jXEPKA7gjbxt26hj\n4h0aCN5i9lXftMIfXeYATOeljyBESTO85CDFbLsylleB/5OtVjzOhukld5qM\nB13RdlKH93W6PYIPE8q3K6Kn1DanpqQhQljxwbmVDUrCvcpBnAbYFtpvFBV9\nLJAjeWUAEQEAAcLAdgQYAQgAKgWCaagzdQmQJjX094XgEEUCmwwWIQTSj6BP\nf7Fss07AItAmNfT3heAQRQAAoWgIAK/WgMe56uCRqJiOIX6XabAX3UyY/B0l\nBroO+sLATXsBpcuv4iRPIumHQaeeXVDK93+vRCnQi7ooOn1K1jE1+gwOJubt\nwN8mDWWzhe/CQh81eFYhD97A8qJbg79zUebmnS920yHRWsZs5hwSTS0zA3RL\nV6kDVw7py7ROYyQ66nTk45qgaYEDwyiGWuj+tlfHOKU71ZtMhWg+0rJjfn+c\nU8z+hIiZ5EtfHL8sSKX84YWX3rKXwl0vnpbUtADSwV3F9+foFuWHT3hSRhy5\ngPCEtZJSz1o6F2mqGab3n3qAw2+Ksp1RW3QJsy6kkOSQGmAdyMBlN1l8L5ct\nqidN19okZ6s=\n=XkH6\n-----END PGP PUBLIC KEY BLOCK-----',
                encryptMessages: false,
                encryptForwarded: false
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(/^[0-9a-f]{24}$/.test(response.body.id)).to.be.true;

        user = response.body.id;
    });

    it('should POST /authenticate expect success', async () => {
        const authResponse = await server
            .post('/authenticate')
            .send({
                username: 'myuser2',
                password: 'secretvalue'
            })
            .expect(200);

        expect(authResponse.body.success).to.be.true;
        expect(authResponse.body).to.deep.equal({
            success: true,
            address: 'john@example.com',
            id: user,
            passwordPwned: true,
            username: 'myuser2',
            scope: 'master',
            require2fa: false,
            requirePasswordChange: false
        });
    });

    it('should POST /authenticate expect failure', async () => {
        const authResponse = await server
            .post('/authenticate')
            .send({
                username: 'myuser2',
                password: 'invalidpass'
            })
            .expect(403);
        expect(authResponse.body.code).to.equal('AuthFailed');
    });

    it('should POST /users expect failure / invalid username', async () => {
        const response = await server
            .post('/users')
            .send({
                username: 'ömyuser2',
                name: 'John Smith',
                password: 'secretvalue'
            })
            .expect(400);

        expect(response.body.details.username).to.exist;
    });

    it('should POST /authenticate expect success / request a token', async () => {
        const authResponse = await server
            .post('/authenticate')
            .send({
                username: 'myuser2',
                password: 'secretvalue',
                token: true
            })
            .expect(200);

        expect(authResponse.body.success).to.be.true;
        expect(authResponse.body.token).to.exist;

        token = authResponse.body.token;
    });

    it('should POST /users expect success / with hashed password', async () => {
        const response = await server
            .post('/users')
            .send({
                username: 'myuser2hash',
                name: 'John Smith',
                // password: 'test',
                password: '$argon2i$v=19$m=16,t=2,p=1$SFpGczI1bWV1RVRpYjNYaw$EBE/WnOGeWint3eQ+SQ7Sg',
                hashedPassword: true
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        user2 = response.body.id;

        const authResponse = await server
            .post('/authenticate')
            .send({
                username: 'myuser2hash',
                password: 'test'
            })
            .expect(200);

        expect(authResponse.body.success).to.be.true;
        expect(authResponse.body).to.deep.equal({
            success: true,
            address: `myuser2hash@${os.hostname().toLowerCase()}`,
            id: user2,
            passwordPwned: true,
            username: 'myuser2hash',
            scope: 'master',
            require2fa: false,
            requirePasswordChange: false
        });
    });

    it('should GET /users/resolve/{username} expect success', async () => {
        const response = await server.get('/users/resolve/myuser2').expect(200);

        expect(response.body).to.deep.equal({
            success: true,
            id: user
        });
    });

    it('should GET /users/resolve/{username} expect failure', async () => {
        const response = await server.get('/users/resolve/myuser2invalid').expect(404);
        expect(response.body.code).to.equal('UserNotFound');
    });

    it('should GET /users expect success', async () => {
        const response = await server.get('/users?query=myuser2').expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.results.find(entry => entry.id === user)).to.exist;
    });

    it('should GET /users/{user} expect success', async () => {
        let response = await server.get(`/users/${user}`).expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.equal(user);
    });

    it('should GET /users/{user} expect success / using a token', async () => {
        let response = await server.get(`/users/${user}?accessToken=${token}`).expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.equal(user);
    });

    it('should GET /users/:user expect success / try /users/me using a token', async () => {
        let response = await server.get(`/users/me?accessToken=${token}`).expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.equal(user);
    });

    it('should GET /users/{user} expect failure / using a token and fail against other user', async () => {
        let response = await server.get(`/users/${user2}?accessToken=${token}`);
        expect(response.body.code).to.equal('MissingPrivileges');
    });

    it('should DELETE /authenticate expect success', async () => {
        let response = await server.delete(`/authenticate?accessToken=${token}`).expect(200);
        expect(response.body.success).to.be.true;
    });

    it('should DELETE /authenticate expect failure / with false', async () => {
        // token is not valid anymore
        await server.delete(`/authenticate?accessToken=${token}`).expect(403);
    });

    it('should PUT /users/{user} expect success', async () => {
        const name = 'John Smith 2';

        // update user data
        const response = await server
            .put(`/users/${user}`)
            .send({
                name
            })
            .expect(200);

        expect(response.body.success).to.be.true;

        // request and verify
        let getResponse = await server.get(`/users/${user}`);
        expect(getResponse.body.success).to.be.true;
        expect(getResponse.body.id).to.equal(user);
        expect(getResponse.body.name).to.equal(name);
    });

    it('should PUT /users/{user} expect success / and renew a token', async () => {
        const authResponse1 = await server
            .post('/authenticate')
            .send({
                username: 'myuser2',
                password: 'secretvalue',
                token: true
            })
            .expect(200);

        expect(authResponse1.body.success).to.be.true;
        expect(authResponse1.body.token).to.exist;

        let token1 = authResponse1.body.token;

        const authResponse2 = await server
            .post('/authenticate')
            .send({
                username: 'myuser2',
                password: 'secretvalue',
                token: true
            })
            .expect(200);

        expect(authResponse2.body.success).to.be.true;
        expect(authResponse2.body.token).to.exist;

        let token2 = authResponse2.body.token;

        // try out token 1
        let getResponse1 = await server.get(`/users/me?accessToken=${token1}`).expect(200);
        expect(getResponse1.body.success).to.be.true;
        expect(getResponse1.body.id).to.equal(user);

        // try out token 2
        let getResponse2 = await server.get(`/users/me?accessToken=${token2}`).expect(200);
        expect(getResponse2.body.success).to.be.true;
        expect(getResponse2.body.id).to.equal(user);

        // update password using a token
        const response = await server
            .put(`/users/me?accessToken=${token1}`)
            .send({
                password: 'secretvalue'
            })
            .expect(200);

        expect(response.body.success).to.be.true;

        // try out token 1, should have been renewed
        let getResponse3 = await server.get(`/users/me?accessToken=${token1}`).expect(200);
        expect(getResponse3.body.success).to.be.true;
        expect(getResponse3.body.id).to.equal(user);

        // try out token 2, should fail as it was not renewed
        await server.get(`/users/me?accessToken=${token2}`).expect(403);
    });

    it('should PUT /users/{user}/logout expect success', async () => {
        // request logout
        const response = await server.put(`/users/${user}/logout`).send({ reason: 'Just because' }).expect(200);
        expect(response.body.success).to.be.true;
    });

    it('should POST /users/{user}/quota/reset expect success', async () => {
        const response = await server.post(`/users/${user}/quota/reset`).send({}).expect(200);
        expect(response.body.success).to.be.true;

        expect(response.body.storageUsed).to.exist;
        expect(response.body.previousStorageUsed).to.exist;
    });

    it('should POST /quota/reset expect success', async () => {
        const response = await server.post(`/quota/reset`).send({}).expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.task).to.exist;
    });

    it('should POST /users/{user}/password/reset expect success', async () => {
        const response = await server.post(`/users/${user}/password/reset`).send({}).expect(200);
        expect(response.body.success).to.be.true;

        expect(response.body.password).to.exist;

        const authResponse = await server
            .post('/authenticate')
            .send({
                username: 'myuser2',
                password: response.body.password
            })
            .expect(200);

        expect(authResponse.body.success).to.be.true;
        expect(authResponse.body).to.deep.equal({
            success: true,
            address: 'john@example.com',
            id: user,
            username: 'myuser2',
            scope: 'master',
            require2fa: false,
            // using a temporary password requires a password change
            requirePasswordChange: true
        });
    });

    it('should POST /users/{user}/password/reset expect success / using a future date', async () => {
        const response = await server
            .post(`/users/${user}/password/reset`)
            .send({
                validAfter: new Date(Date.now() + 1 * 3600 * 1000).toISOString()
            })
            .expect(200);
        expect(response.body.success).to.be.true;

        expect(response.body.password).to.exist;

        // password not yet valid
        await server
            .post('/authenticate')
            .send({
                username: 'myuser2',
                password: response.body.password
            })
            .expect(403);
    });

    it('should DELETE /users/{user} expect success', async () => {
        // first set the user password
        const passwordUpdateResponse = await server
            .put(`/users/${user}`)
            .send({
                password: 'secretvalue',
                ip: '1.2.3.5'
            })
            .expect(200);

        expect(passwordUpdateResponse.body.success).to.be.true;

        // Delete user
        const response = await server.delete(`/users/${user}?deleteAfter=${encodeURIComponent(new Date(Date.now() + 3600 * 1000).toISOString())}`).expect(200);
        expect(response.body.success).to.be.true;

        expect(response.body.addresses.deleted).to.gte(1);
        expect(response.body.task).to.exist;

        // Try to authenticate, should fail
        await server
            .post('/authenticate')
            .send({
                username: 'myuser2',
                password: 'secretvalue'
            })
            .expect(403);
    });

    it('should GET /users/{user}/restore expect success', async () => {
        const response = await server.get(`/users/${user}/restore`).expect(200);
        expect(response.body.success).to.be.true;

        expect(response.body.username).to.equal('myuser2');
        expect(response.body.recoverableAddresses).to.deep.equal(['john@example.com']);
    });

    it('should POST /users/{user}/restore expect success', async () => {
        const response = await server.post(`/users/${user}/restore`).send({}).expect(200);
        expect(response.body.success).to.be.true;

        expect(response.body.addresses.recovered).to.gte(1);
        expect(response.body.addresses.main).to.equal('john@example.com');
    });

    it('should POST /users expect success / with DES hash', async () => {
        const response = await server
            .post('/users')
            .send({
                username: 'desuser',
                name: 'Crypt Des',
                address: 'des@example.com',
                password: 'sBk81TlWxyZlc',
                hashedPassword: true
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(/^[0-9a-f]{24}$/.test(response.body.id)).to.be.true;

        const authResponseSuccess = await server
            .post('/authenticate')
            .send({
                username: 'desuser',
                password: '12Mina34Ise56P.'
            })
            .expect(200);
        expect(authResponseSuccess.body.success).to.be.true;

        const authResponseFail = await server
            .post('/authenticate')
            .send({
                username: 'desuser',
                password: 'wrongpass'
            })
            .expect(403);
        expect(authResponseFail.body.error).to.exist;
    });
});
