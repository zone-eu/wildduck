/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */

/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('Storage tests', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user;

    before(async () => {
        // ensure that we have an existing user account
        const response = await server
            .post('/users')
            .send({
                username: 'storageuser',
                password: 'secretvalue',
                address: 'storageuser.addrtest@example.com',
                name: 'storage user'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.exist;

        user = response.body.id;
    });

    after(async () => {
        if (!user) {
            return;
        }

        const response = await server.delete(`/users/${user}`).expect(200);
        expect(response.body.success).to.be.true;

        user = false;
    });

    it('should POST /users/{user}/storage expect success', async () => {
        const response = await server
            .post(`/users/${user}/storage`)
            .send({
                filename: 'image.gif',
                contentType: 'image/gif',
                encoding: 'base64',
                content:
                    'R0lGODlhEAAQAMQAAORHHOVSKudfOulrSOp3WOyDZu6QdvCchPGolfO0o/XBs/fNwfjZ0frl3/zy7////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACH5BAkAABAALAAAAAAQABAAAAVVICSOZGlCQAosJ6mu7fiyZeKqNKToQGDsM8hBADgUXoGAiqhSvp5QAnQKGIgUhwFUYLCVDFCrKUE1lBavAViFIDlTImbKC5Gm2hB0SlBCBMQiB0UjIQA7'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.be.not.empty;
    });

    it('should POST /users/{user}/storage expect success / filename undefined', async () => {
        const response = await server
            .post(`/users/${user}/storage`)
            .send({
                contentType: 'image/gif',
                encoding: 'base64',
                content:
                    'R0lGODlhEAAQAMQAAORHHOVSKudfOulrSOp3WOyDZu6QdvCchPGolfO0o/XBs/fNwfjZ0frl3/zy7////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACH5BAkAABAALAAAAAAQABAAAAVVICSOZGlCQAosJ6mu7fiyZeKqNKToQGDsM8hBADgUXoGAiqhSvp5QAnQKGIgUhwFUYLCVDFCrKUE1lBavAViFIDlTImbKC5Gm2hB0SlBCBMQiB0UjIQA7'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.be.not.empty;
    });

    it('should POST /users/{user}/storage expect success / filename undefined, contentType undefined', async () => {
        const response = await server
            .post(`/users/${user}/storage`)
            .send({
                encoding: 'base64',
                content:
                    'R0lGODlhEAAQAMQAAORHHOVSKudfOulrSOp3WOyDZu6QdvCchPGolfO0o/XBs/fNwfjZ0frl3/zy7////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACH5BAkAABAALAAAAAAQABAAAAVVICSOZGlCQAosJ6mu7fiyZeKqNKToQGDsM8hBADgUXoGAiqhSvp5QAnQKGIgUhwFUYLCVDFCrKUE1lBavAViFIDlTImbKC5Gm2hB0SlBCBMQiB0UjIQA7'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.be.not.empty;
    });

    it('should POST /users/{user}/storage expect failure / content missing', async () => {
        const response = await server
            .post(`/users/${user}/storage`)
            .send({
                filename: 'image.gif',
                contentType: 'image/gif',
                encoding: 'base64'
            })
            .expect(400);
        expect(response.body.code).to.be.equal('InputValidationError');
    });

    it('should POST /users/{user}/storage expect failure / incorrect user id', async () => {
        const response = await server
            .post(`/users/123/storage`)
            .send({
                filename: 'image.gif',
                contentType: 'image/gif',
                encoding: 'base64',
                content:
                    'R0lGODlhEAAQAMQAAORHHOVSKudfOulrSOp3WOyDZu6QdvCchPGolfO0o/XBs/fNwfjZ0frl3/zy7////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACH5BAkAABAALAAAAAAQABAAAAVVICSOZGlCQAosJ6mu7fiyZeKqNKToQGDsM8hBADgUXoGAiqhSvp5QAnQKGIgUhwFUYLCVDFCrKUE1lBavAViFIDlTImbKC5Gm2hB0SlBCBMQiB0UjIQA7'
            })
            .expect(400);
        expect(response.body.code).to.be.equal('InputValidationError');
    });

    it('should POST /users/{user}/storage expect failure / user not found', async () => {
        const response = await server
            .post(`/users/${'0'.repeat(24)}/storage`)
            .send({
                filename: 'image.gif',
                contentType: 'image/gif',
                encoding: 'base64',
                content:
                    'R0lGODlhEAAQAMQAAORHHOVSKudfOulrSOp3WOyDZu6QdvCchPGolfO0o/XBs/fNwfjZ0frl3/zy7////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACH5BAkAABAALAAAAAAQABAAAAVVICSOZGlCQAosJ6mu7fiyZeKqNKToQGDsM8hBADgUXoGAiqhSvp5QAnQKGIgUhwFUYLCVDFCrKUE1lBavAViFIDlTImbKC5Gm2hB0SlBCBMQiB0UjIQA7'
            })
            .expect(404);
        expect(response.body.code).to.be.equal('UserNotFound');
        expect(response.body.error).to.be.equal('This user does not exist');
    });

    it('should GET /users/{user}/storage expect success', async () => {
        const response = await server.get(`/users/${user}/storage`).send({}).expect(200);
        expect(response.body.success).to.be.true;
    });

    it('should GET /users/{user}/storage expect success / different limit', async () => {
        const response = await server.get(`/users/${user}/storage?limit=5`).send({}).expect(200);
        expect(response.body.success).to.be.true;
    });

    it('should GET /users/{user}/storage expect success / stored contentType is returned', async () => {
        // the file extension maps to a different type, so a lost contentType can not be inferred back
        const upload = await server
            .post(`/users/${user}/storage`)
            .send({
                filename: 'contenttype-check.dat',
                contentType: 'application/pdf',
                encoding: 'base64',
                content: Buffer.from('content type check').toString('base64')
            })
            .expect(200);
        expect(upload.body.success).to.be.true;

        const listing = await server.get(`/users/${user}/storage`).send({}).expect(200);
        const fileData = listing.body.results.find(entry => entry.id === upload.body.id);
        expect(fileData).to.exist;
        expect(fileData.contentType).to.equal('application/pdf');

        const download = await server
            .get(`/users/${user}/storage/${upload.body.id}`)
            .buffer(true)
            .parse((res, callback) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => callback(null, Buffer.concat(chunks)));
            })
            .expect(200);
        expect(download.headers['content-type']).to.equal('application/pdf');
        expect(download.body.toString()).to.equal('content type check');

        await server.del(`/users/${user}/storage/${upload.body.id}`).send({}).expect(200);
    });

    it('should GET /users/{user}/storage expect failure / incorrect limit', async () => {
        const response = await server.get(`/users/${user}/storage?limit=1000`).send({}).expect(400);
        expect(response.body.code).to.be.equal('InputValidationError');
    });

    it('should GET /users/{user}/storage expect failure / user not found', async () => {
        const response = await server
            .get(`/users/${'0'.repeat(24)}/storage`)
            .send({})
            .expect(404);
        expect(response.body.code).to.be.equal('UserNotFound');
        expect(response.body.error).to.be.equal('This user does not exist');
    });

    it('should DELETE /users/{user}/storage/{file} expect success', async () => {
        const userFiles = await server.get(`/users/${user}/storage`).send({}).expect(200);

        const response = await server.del(`/users/${user}/storage/${userFiles.body.results[0].id}`).send({}).expect(200);
        expect(response.body.success).to.be.true;
    });

    it('should DELETE /users/{user}/storage/{file} expect failure / file format incorrect', async () => {
        const response = await server.del(`/users/${user}/storage/${123}`).send({}).expect(400);
        expect(response.body.code).to.be.equal('InputValidationError');
    });

    it('should DELETE /users/{user}/storage/{file} expect failure / file missing, incorrect file id', async () => {
        const userFiles = await server.get(`/users/${user}/storage`).send({}).expect(200);

        const response = await server
            .del(`/users/${user}/storage/${Array.from(userFiles.body.results[0].id).reverse().join('')}`)
            .send({})
            .expect(404);
        expect(response.body.code).to.be.equal('FileNotFound');
    });

    it('should GET /users/{user}/storage/{file} expect success', async () => {
        const userFiles = await server.get(`/users/${user}/storage`).send({}).expect(200);

        const response = await server.del(`/users/${user}/storage/${userFiles.body.results[0].id}`).send({}).expect(200);
        expect(response.body.success).to.be.true;
    });

    it('should GET /users/{user}/storage/{file} expect failure / file format incorrect', async () => {
        const response = await server.get(`/users/${user}/storage/${123}`).send({}).expect(400);
        expect(response.body.code).to.be.equal('InputValidationError');
    });

    it('should GET /users/{user}/storage/{file} expect failure / file missing, incorrect file id', async () => {
        const response = await server
            .get(`/users/${user}/storage/${'0'.repeat(24)}`)
            .send({})
            .expect(404);
        expect(response.body.code).to.be.equal('FileNotFound');
    });
});
