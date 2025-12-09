'use strict';

const crypto = require('crypto');
const assert = require('assert');

function parseEncryptedData(encryptedData, defaultCipher) {
    encryptedData = (encryptedData || '').toString();
    if (!encryptedData) {
        return false;
    }

    if (encryptedData.charAt(0) !== '$') {
        // cleartext
        return {
            format: 'cleartext',
            data: encryptedData
        };
    }

    if (encryptedData.lastIndexOf('$') === 0) {
        // legacy
        return {
            format: 'legacy',
            cipher: defaultCipher || 'aes192',
            data: Buffer.from(encryptedData.substr(1), 'hex')
        };
    }

    let [, format, cipher, authTag, iv, salt, encryptedText] = encryptedData.split('$');
    if (!format || !cipher || !authTag || !iv || !encryptedText) {
        return false;
    }

    authTag = Buffer.from(authTag, 'hex');
    iv = Buffer.from(iv, 'hex');
    salt = Buffer.from(salt, 'hex');
    encryptedText = Buffer.from(encryptedText, 'hex');

    return {
        format,
        cipher,
        authTag,
        iv,
        salt,
        data: encryptedText
    };
}

function getKeyFromPassword(password, salt, keyLen) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, keyLen, (err, result) => {
            if (err) {
                return reject(err);
            }
            if (!result) {
                return reject(new Error('Failed to hash key'));
            }
            return resolve(result);
        });
    });
}

async function decrypt(encryptedData, secret, defaultCipher) {
    const decryptData = parseEncryptedData(encryptedData, defaultCipher);
    if (!decryptData) {
        return encryptedData;
    }

    if (!secret && decryptData.format !== 'cleartext') {
        // data is encrypted but we do not have a secret
        let err = new Error('Failed to decrypt data. No secret provided.');
        err.responseCode = 500;
        err.code = 'InternalConfigError';
        throw err;
    }

    switch (decryptData.format) {
        case 'cleartext':
            return encryptedData;

        case 'legacy':
            try {
                const info = crypto.getCipherInfo(decryptData.cipher);
                if (!info || !info.keyLength || !info.ivLength) {
                    throw new Error('Unsupported legacy cipher: ' + decryptData.cipher);
                }

                const { key, iv } = evpBytesToKey(secret, info.keyLength, info.ivLength);

                let decipher = crypto.createDecipheriv(decryptData.cipher, key, iv);
                return Buffer.concat([decipher.update(decryptData.data), decipher.final()]).toString('utf-8');
            } catch (E) {
                let err = new Error('Failed to decrypt data. ' + E.message);
                err.responseCode = 500;
                err.code = 'InternalConfigError';
                throw err;
            }

        case 'wd01':
            try {
                assert.strictEqual(decryptData.authTag.length, 16, 'Invalid auth tag length');
                assert.strictEqual(decryptData.iv.length, 12, 'Invalid iv length');
                assert.strictEqual(decryptData.salt.length, 16, 'Invalid salt length');

                // convert password to 32B key
                const key = await getKeyFromPassword(secret, decryptData.salt, 32);

                const decipher = crypto.createDecipheriv(decryptData.cipher, key, decryptData.iv, { authTagLength: decryptData.authTag.length });
                decipher.setAuthTag(decryptData.authTag);
                return Buffer.concat([decipher.update(decryptData.data), decipher.final()]).toString('utf-8');
            } catch (E) {
                let err = new Error('Failed to decrypt data. ' + E.message);
                err.responseCode = 500;
                err.code = 'InternalConfigError';
                throw err;
            }

        default: {
            let err = new Error('Unknown encryption format: ' + decryptData.format);
            err.responseCode = 500;
            err.code = 'InternalConfigError';
            throw err;
        }
    }
}

async function encrypt(cleartext, secret) {
    if (!secret) {
        return cleartext;
    }

    const iv = crypto.randomBytes(12);
    const salt = crypto.randomBytes(16);

    const key = await getKeyFromPassword(secret, salt, 32);

    const format = 'wd01';
    const algo = 'aes-256-gcm';

    const cipher = crypto.createCipheriv(algo, key, iv, { authTagLength: 16 });
    const encryptedText = Buffer.concat([cipher.update(cleartext), cipher.final()]);

    const authTag = cipher.getAuthTag();

    return ['', format, algo].concat([authTag, iv, salt, encryptedText].map(buf => buf.toString('hex'))).join('$');
}

// Simple re-implementation (without salt) of the KDF used by crypto.createCipher/createDecipher
function evpBytesToKey(password, keyLen, ivLen) {
    const pwd = Buffer.isBuffer(password) ? password : Buffer.from(password, 'binary');

    const totalLen = keyLen + ivLen;
    let derived = Buffer.alloc(0);
    let prev = Buffer.alloc(0);

    while (derived.length < totalLen) {
        const hash = crypto.createHash('md5');
        hash.update(prev);
        hash.update(pwd);

        prev = hash.digest();
        derived = Buffer.concat([derived, prev]);
    }

    return {
        key: derived.subarray(0, keyLen),
        iv: derived.subarray(keyLen, keyLen + ivLen)
    };
}

module.exports = { encrypt, decrypt };
