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
                pubKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nVersion: Keybase OpenPGP v1.0.0\nComment: https://keybase.io/crypto\n\nxo0EYb0PqAEEANJtI/ivwudfCMmxm+a77Fll5YwSzaaI2nqhcp6pMRJ4l0aafsX3\nBcXUQpsyyELelt2xFtwTNygR4RFWVTn4OoXmO5zFtWCSegAwSyUNK7R/GXi2GTKk\nkYtxUwGcNKBkfY7yAn5KsaeuZL1feDXUGt0YHUmBds5i+6ylI+i4tNbRABEBAAHN\nH1dpbGQgRHVjayA8dGVzdEB3aWxkZHVjay5lbWFpbD7CrQQTAQoAFwUCYb0PqAIb\nLwMLCQcDFQoIAh4BAheAAAoJEJVLs8wf5gSCzBoD/3gz32OfJM1D4IrmKVwyLKxC\n1P81kL7E6ICWD2A0JF9EkojsMHl+/zagwoJejBQhmzTNkFmui5zwmdLGforKl303\ntB0l9vCTb5+eDDHOTUatJrvlw76Fz2ZjIhQTqD4xEM7MWx4xwTGY8bC5roIpdZJD\n9+vr81MXxiq9LZJDBXIyzo0EYb0PqAEEAL/uCTOrAncTRC/3cOQz+kLIzF4A9OTe\n6yxdNWWmx+uo9yJxnBv59Xz9qt8OT8Ih7SD/A4kFCuQqlyd0OFVhyd3KTAQ3CEml\nYOgL5jOE11YrEQjr36xPqO646JZuZIorKDf9PoIyipAMG89BlAoAjSXB1oeQADYn\n5fFLFVm1S7pLABEBAAHCwIMEGAEKAA8FAmG9D6gFCQ8JnAACGy4AqAkQlUuzzB/m\nBIKdIAQZAQoABgUCYb0PqAAKCRBhR/oKY9pg/YqnA/0Szmy4q4TnTBby+j57oXtn\nX/7H/xiaqlCd6bA3lbj3cPK4ybn/gnI4ECsfZfmSFG3T5C9EcZU0e9ByzimH6sxi\nOwPgKFWeJzpl5o8toR7m4wQVhv2NZRUukHe+2JH7nITS0gKeIBHMq2TbufcH6do1\n8s2G7XyLSd5Kkljxx7YmNiKoA/9CQ4l2WkARAFByyEJT9BEE4NBO0m0bI8sg0HRK\nGuP3FKcUu0Pz9R8AExEecofh8s4kaxofa2sbrTcK+L0p0hdR/39JWNuTJbxwEU3C\nA0mZKthjzL7seiRTG7Eny5gGenejRp2x0ziyMEaTgkvf44LPi06XiuE6FGnhElOc\nC7JoIc6NBGG9D6gBBADzW30GOysnqYkexL+bY9o+ai1mL+X58GPLilXJ5WXgEEdf\n8Pg/9jlEOzOnWTTgJAQDGHtwm0duKmK7EJGozLEY94QGOzRjAir6tMF2OYDQIDgj\nAoXavPAc5chFABEVUS12hUPPLoW6YgvaIb3AAZbIM8603BLXTaLGbtZ0z7eYxwAR\nAQABwsCDBBgBCgAPBQJhvQ+oBQkPCZwAAhsuAKgJEJVLs8wf5gSCnSAEGQEKAAYF\nAmG9D6gACgkQ58zrS0TNGbAiVAP/UIxYiSdoHDnBW5qB7onEiUVL5ZFk1Xk+NB0z\n7jOm1oAV0RH8I5NRQBtZ+75xar0vPTX122IdkgpaiNT0wy5Kd/2vz4LKVK9apyJI\neaZ+D7dt5Ipu1p0lWtglqL0xtjOSWuwHFwHuiRYg6eyhGN1RylFpuiKi5KykhrBS\nuBL/BHrk6AP/boRA+KIlb6s19KHNt54Kl8n8G4ZApCwZbUc2jzvbP5DZL5rcjlHd\ns4i4XE+uIJxsiX3iJZtVXzhTKuQlaoEljlhPs/TZYUmxeJ3TdV4o7emWiZ4gE8EQ\nhfxV37ew/GoYm6yME3tAZLIXbv2+bj6HZ4eE8bAMmPvpcQ+UwNJXvnk=\n=dR+x\n-----END PGP PUBLIC KEY BLOCK-----',
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
