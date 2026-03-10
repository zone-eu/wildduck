'use strict';

// CMS EnvelopedData (RFC 5652) and AuthEnvelopedData (RFC 5083) builder
// using asn1js + Node.js crypto only. No pkijs or @peculiar/webcrypto dependency.

const asn1js = require('asn1js');
const crypto = require('crypto');

const subtle = crypto.webcrypto.subtle;

// Set by server.js at startup after probing OpenSSL capabilities.
let pkcs1v15Available = false;

// OIDs
const OID_ENVELOPED_DATA = '1.2.840.113549.1.7.3'; // id-envelopedData
const OID_AUTH_ENVELOPED_DATA = '1.2.840.113549.1.9.16.1.23'; // id-ct-authEnvelopedData
const OID_DATA = '1.2.840.113549.1.7.1'; // id-data
const OID_AES_256_CBC = '2.16.840.1.101.3.4.1.42'; // id-aes256-CBC
const OID_AES_256_GCM = '2.16.840.1.101.3.4.1.46'; // id-aes256-GCM
const OID_RSAES_OAEP = '1.2.840.113549.1.1.7'; // id-RSAES-OAEP
const OID_SHA256 = '2.16.840.1.101.3.4.2.1'; // id-sha256
const OID_MGF1 = '1.2.840.113549.1.1.8'; // id-mgf1
const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1'; // rsaEncryption (PKCS#1 v1.5)

// ECDH OIDs
const OID_DH_SINGLE_PASS_STD_DH_SHA256KDF = '1.3.132.1.11.1'; // dhSinglePass-stdDH-sha256kdf-scheme
const OID_AES_256_WRAP = '2.16.840.1.101.3.4.1.45'; // id-aes256-wrap
const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1'; // id-ecPublicKey

function toArrayBuffer(buf) {
    return new Uint8Array(buf).buffer;
}

/**
 * X9.63 / ANSI-X9.63-KDF key derivation using SHA-256.
 * SEC 1 v2.0 §3.6.1 / RFC 8418 §2.
 * @param {Buffer} z - shared secret
 * @param {number} keyLength - desired key length in bytes
 * @param {Buffer} otherInfo - DER-encoded ECC-CMS-SharedInfo
 * @returns {Buffer} derived key material
 */
function kdfX963(z, keyLength, otherInfo) {
    let counter = Buffer.allocUnsafe(4);
    let result = [];
    let bytes = 0;
    while (bytes < keyLength) {
        counter.writeUInt32BE(result.length + 1);
        let hash = crypto.createHash('sha256');
        hash.update(z);
        hash.update(counter);
        hash.update(otherInfo);
        let digest = hash.digest();
        bytes += digest.length;
        result.push(digest);
    }
    return Buffer.concat(result, keyLength);
}

/**
 * Build DER-encoded ECC-CMS-SharedInfo (RFC 5753 §7.2):
 *   ECC-CMS-SharedInfo ::= SEQUENCE {
 *     keyInfo         AlgorithmIdentifier,
 *     entityUInfo [0] EXPLICIT OCTET STRING OPTIONAL, -- omitted
 *     suppPubInfo [2] EXPLICIT OCTET STRING  -- key length in bits, 4 bytes big-endian
 *   }
 * @param {string} wrapAlgOid - OID of the key wrap algorithm
 * @param {number} keydatalenBits - key length in bits
 * @returns {Buffer} DER-encoded SharedInfo
 */
function buildEccCmsSharedInfo(wrapAlgOid, keydatalenBits) {
    let lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(keydatalenBits, 0);
    return Buffer.from(
        new asn1js.Sequence({
            value: [
                // AlgorithmIdentifier { algorithm OID }
                new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: wrapAlgOid })] }),
                // suppPubInfo [2] EXPLICIT OCTET STRING
                new asn1js.Constructed({
                    idBlock: { tagClass: 3, tagNumber: 2 },
                    value: [new asn1js.OctetString({ valueHex: toArrayBuffer(lenBuf) })]
                })
            ]
        }).toBER(false)
    );
}

/**
 * Build a KeyAgreeRecipientInfo for one EC recipient.
 * Uses dhSinglePass-stdDH-sha256kdf-scheme with AES-256 Key Wrap.
 *
 * RecipientInfo ::= CHOICE {
 *   ...
 *   kari [1] KeyAgreeRecipientInfo
 * }
 *
 * KeyAgreeRecipientInfo ::= SEQUENCE {
 *   version                 CMSVersion,                       -- v3
 *   originator              [0] EXPLICIT OriginatorIdentifierOrKey,
 *   ukm                     [1] EXPLICIT UserKeyingMaterial OPTIONAL, -- omitted
 *   keyEncryptionAlgorithm  KeyEncryptionAlgorithmIdentifier,
 *   recipientEncryptedKeys  RecipientEncryptedKeys
 * }
 *
 * OriginatorIdentifierOrKey ::= CHOICE {
 *   ...
 *   originatorKey [1] OriginatorPublicKey
 * }
 *
 * OriginatorPublicKey ::= SEQUENCE {
 *   algorithm   AlgorithmIdentifier,  -- id-ecPublicKey
 *   publicKey   BIT STRING            -- ephemeral EC point
 * }
 *
 * RecipientEncryptedKeys ::= SEQUENCE OF RecipientEncryptedKey
 * RecipientEncryptedKey ::= SEQUENCE {
 *   rid          KeyAgreeRecipientIdentifier, -- issuerAndSerialNumber used here
 *   encryptedKey EncryptedKey                 -- wrapped CEK as OCTET STRING
 * }
 * @param {object} recip - { issuer, serialNumber, publicKey (crypto.KeyObject) }
 * @param {Buffer} cek - content encryption key to wrap
 * @param {string} cekAlg - WebCrypto algorithm name for the CEK ('AES-GCM' or 'AES-CBC')
 * @returns {Promise<asn1js.Constructed>} [1] IMPLICIT KeyAgreeRecipientInfo
 */
async function buildKeyAgreeRecipientInfo(recip, cek, cekAlg) {
    let namedCurve = recip.publicKey.asymmetricKeyDetails.namedCurve;

    // Generate ephemeral ECDH key pair on the same curve
    let { publicKey: ephPub, privateKey: ephPriv } = crypto.generateKeyPairSync('ec', { namedCurve });

    // Derive shared secret Z (x-coordinate of shared point)
    let sharedSecret = crypto.diffieHellman({ privateKey: ephPriv, publicKey: recip.publicKey });

    // Derive KEK via X9.63 KDF with ECC-CMS-SharedInfo
    let otherInfo = buildEccCmsSharedInfo(OID_AES_256_WRAP, 256);
    let kek;
    let wrappedKey;
    try {
        kek = kdfX963(sharedSecret, 32, otherInfo);

        // AES-256 Key Wrap the CEK via WebCrypto
        let kekKey = await subtle.importKey('raw', kek, { name: 'AES-KW' }, false, ['wrapKey']);
        let cekKey = await subtle.importKey('raw', cek, { name: cekAlg, length: 256 }, true, ['encrypt']);
        wrappedKey = Buffer.from(await subtle.wrapKey('raw', cekKey, kekKey, { name: 'AES-KW' }));
    } finally {
        sharedSecret.fill(0);
        if (kek) {
            kek.fill(0);
        }
    }

    // Export ephemeral public key SPKI DER and extract the BIT STRING
    let ephSpki = ephPub.export({ type: 'spki', format: 'der' });
    let ephSpkiAsn1 = asn1js.fromBER(toArrayBuffer(ephSpki));
    let ephBitString = ephSpkiAsn1.result.valueBlock.value[1]; // BIT STRING with the public key point

    // Minimal AlgorithmIdentifier for OriginatorPublicKey (just id-ecPublicKey, no curve OID).
    // The recipient infers the curve from its own certificate.
    let ephAlgId = new asn1js.Sequence({
        value: [new asn1js.ObjectIdentifier({ value: OID_EC_PUBLIC_KEY })]
    });

    // KeyAgreeRecipientInfo ::= SEQUENCE {
    //   version                 INTEGER (3),
    //   originator              [0] EXPLICIT OriginatorIdentifierOrKey,
    //   ukm                     [1] EXPLICIT OCTET STRING OPTIONAL,  -- omitted
    //   keyEncryptionAlgorithm  AlgorithmIdentifier,
    //   recipientEncryptedKeys  SEQUENCE OF RecipientEncryptedKey
    // }
    return new asn1js.Constructed({
        idBlock: { tagClass: 3, tagNumber: 1 }, // [1] IMPLICIT for KeyAgreeRecipientInfo
        value: [
            new asn1js.Integer({ value: 3 }), // version
            // originator [0] EXPLICIT { [1] IMPLICIT OriginatorPublicKey }
            new asn1js.Constructed({
                idBlock: { tagClass: 3, tagNumber: 0 },
                value: [
                    new asn1js.Constructed({
                        idBlock: { tagClass: 3, tagNumber: 1 },
                        value: [ephAlgId, ephBitString]
                    })
                ]
            }), // keyEncryptionAlgorithm
            new asn1js.Sequence({
                value: [
                    new asn1js.ObjectIdentifier({ value: OID_DH_SINGLE_PASS_STD_DH_SHA256KDF }),
                    new asn1js.Sequence({
                        value: [new asn1js.ObjectIdentifier({ value: OID_AES_256_WRAP })]
                    })
                ]
            }), // recipientEncryptedKeys SEQUENCE OF RecipientEncryptedKey
            new asn1js.Sequence({
                value: [
                    new asn1js.Sequence({
                        value: [
                            new asn1js.Sequence({
                                value: [recip.issuer, recip.serialNumber]
                            }),
                            new asn1js.OctetString({ valueHex: toArrayBuffer(wrappedKey) })
                        ]
                    })
                ]
            })
        ]
    });
}

/**
 * Build AlgorithmIdentifier for RSAES-OAEP with SHA-256 + MGF1(SHA-256).
 *
 * AlgorithmIdentifier ::= SEQUENCE {
 *   algorithm   OBJECT IDENTIFIER,   -- id-RSAES-OAEP
 *   parameters  RSAES-OAEP-params
 * }
 *
 * RSAES-OAEP-params ::= SEQUENCE {
 *   hashAlgorithm      [0] HashAlgorithm     DEFAULT sha1Identifier,
 *   maskGenAlgorithm   [1] MaskGenAlgorithm  DEFAULT mgf1SHA1Identifier,
 *   pSourceAlgorithm   [2] PSourceAlgorithm  DEFAULT pSpecifiedEmptyIdentifier
 * }
 *
 * Encoded fields:
 *   [0] hashAlgorithm    = id-sha256
 *   [1] maskGenAlgorithm = id-mgf1 with id-sha256
 *   [2] pSourceAlgorithm is omitted (default pSpecified with empty string)
 *
 * @returns {asn1js.Sequence} DER-ready AlgorithmIdentifier
 */
function buildOaepAlgorithmIdentifier() {
    return new asn1js.Sequence({
        value: [
            new asn1js.ObjectIdentifier({ value: OID_RSAES_OAEP }), // RSAES-OAEP-params
            new asn1js.Sequence({
                value: [
                    // [0] hashAlgorithm = SHA-256
                    new asn1js.Constructed({
                        idBlock: { tagClass: 3, tagNumber: 0 },
                        value: [
                            new asn1js.Sequence({
                                value: [new asn1js.ObjectIdentifier({ value: OID_SHA256 })]
                            })
                        ]
                    }), // [1] maskGenAlgorithm = MGF1 with SHA-256
                    new asn1js.Constructed({
                        idBlock: { tagClass: 3, tagNumber: 1 },
                        value: [
                            new asn1js.Sequence({
                                value: [
                                    new asn1js.ObjectIdentifier({ value: OID_MGF1 }),
                                    new asn1js.Sequence({
                                        value: [new asn1js.ObjectIdentifier({ value: OID_SHA256 })]
                                    })
                                ]
                            })
                        ]
                    })
                ]
            })
        ]
    });
}

/**
 * Build AlgorithmIdentifier for rsaEncryption (PKCS#1 v1.5 key transport).
 *
 * AlgorithmIdentifier ::= SEQUENCE {
 *   algorithm   OBJECT IDENTIFIER,  -- rsaEncryption
 *   parameters  NULL
 * }
 *
 * @returns {asn1js.Sequence} DER-ready AlgorithmIdentifier
 */
function buildPkcs1AlgorithmIdentifier() {
    return new asn1js.Sequence({
        value: [new asn1js.ObjectIdentifier({ value: OID_RSA_ENCRYPTION }), new asn1js.Null()]
    });
}

/**
 * Parse PEM certificates and extract issuer, serialNumber, publicKey, keyType.
 * @param {string[]} certs - PEM certificate strings
 * @returns {object[]} array of { issuer, serialNumber, publicKey, keyType }
 */
function parseRecipients(certs) {
    let recipients = [];
    for (let pem of certs) {
        try {
            let x509 = new crypto.X509Certificate(pem);
            let certAsn1 = asn1js.fromBER(toArrayBuffer(x509.raw));
            if (certAsn1.offset === -1) {
                continue;
            }

            // TBSCertificate is the first element of the outer Certificate SEQUENCE
            let tbsCert = certAsn1.result.valueBlock.value[0];
            let tbsValues = tbsCert.valueBlock.value;
            let idx = 0;

            // Skip version [0] EXPLICIT if present
            if (tbsValues[idx].idBlock.tagClass === 3 && tbsValues[idx].idBlock.tagNumber === 0) {
                idx++;
            }

            let serialNumber = tbsValues[idx]; // CertificateSerialNumber (INTEGER)
            idx += 2; // skip serialNumber + signature AlgorithmIdentifier
            let issuer = tbsValues[idx]; // Name (SEQUENCE)

            let publicKey = crypto.createPublicKey(pem);
            let keyType = publicKey.asymmetricKeyType; // 'rsa' or 'ec'

            recipients.push({ issuer, serialNumber, publicKey, keyType });
        } catch (err) {
            continue;
        }
    }
    return recipients;
}

/**
 * Build RSA KeyTransRecipientInfo and wrap the CEK.
 *
 * RecipientInfo ::= CHOICE {
 *   ktri KeyTransRecipientInfo,
 *   ...
 * }
 *
 * KeyTransRecipientInfo ::= SEQUENCE {
 *   version                CMSVersion,                      -- v0 (issuerAndSerialNumber)
 *   rid                    RecipientIdentifier,             -- issuerAndSerialNumber
 *   keyEncryptionAlgorithm KeyEncryptionAlgorithmIdentifier,
 *   encryptedKey           EncryptedKey                     -- OCTET STRING
 * }
 * @param {object} recip - { issuer, serialNumber, publicKey }
 * @param {Buffer} cek - content encryption key
 * @param {string} keyTransport - 'OAEP' or 'PKCS#1 v1.5'
 * @returns {asn1js.Sequence} KeyTransRecipientInfo
 */
function buildKeyTransRecipientInfo(recip, cek, keyTransport) {
    let wrappedKey;
    let algId;
    if (keyTransport === 'OAEP') {
        wrappedKey = crypto.publicEncrypt(
            {
                key: recip.publicKey,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256'
            },
            cek
        );
        algId = buildOaepAlgorithmIdentifier();
    } else {
        if (!pkcs1v15Available) {
            throw new Error(
                'RSA PKCS#1 v1.5 key transport is not available in this OpenSSL build (' +
                    process.versions.openssl +
                    '). Restart with --openssl-legacy-provider or switch user to OAEP key transport.'
            );
        }
        wrappedKey = crypto.publicEncrypt(
            {
                key: recip.publicKey,
                padding: crypto.constants.RSA_PKCS1_PADDING
            },
            cek
        );
        algId = buildPkcs1AlgorithmIdentifier();
    }

    if (!wrappedKey || !wrappedKey.length) {
        throw new Error('RSA key wrapping produced empty encryptedKey');
    }

    // KeyTransRecipientInfo ::= SEQUENCE {
    //   version          INTEGER (0 for issuerAndSerialNumber),
    //   rid              IssuerAndSerialNumber,
    //   keyEncryptionAlgorithm  AlgorithmIdentifier,
    //   encryptedKey     OCTET STRING
    // }
    return new asn1js.Sequence({
        value: [
            new asn1js.Integer({ value: 0 }),
            new asn1js.Sequence({
                value: [recip.issuer, recip.serialNumber]
            }),
            algId,
            new asn1js.OctetString({ valueHex: toArrayBuffer(wrappedKey) })
        ]
    });
}

class SMIMEEncryptor {
    /**
     * Encrypt plaintext using AES-256-GCM and wrap in CMS AuthEnvelopedData (RFC 5083).
     *
     * Built top-level CMS object:
     * ContentInfo ::= SEQUENCE {
     *   contentType OBJECT IDENTIFIER,                  -- id-ct-authEnvelopedData
     *   content     [0] EXPLICIT AuthEnvelopedData
     * }
     *
     * AuthEnvelopedData ::= SEQUENCE {
     *   version                 INTEGER,                -- 0
     *   recipientInfos          SET OF RecipientInfo,
     *   authEncryptedContentInfo EncryptedContentInfo,
     *   mac                     OCTET STRING            -- GCM tag
     * }
     *
     * EncryptedContentInfo.contentEncryptionAlgorithm uses:
     *   id-aes256-GCM with GCMParameters ::= SEQUENCE {
     *     aes-nonce  OCTET STRING,                      -- 12-byte nonce
     *     aes-ICVlen INTEGER                            -- 16-byte tag
     *   }
     * @param {string[]} certs - PEM certificate strings
     * @param {Buffer} plaintext - raw message bytes
     * @param {object} [options]
     * @param {string} [options.keyTransport='OAEP'] - RSA key transport: 'PKCS#1 v1.5' or 'OAEP'
     * @returns {Promise<Buffer|false>} DER-encoded CMS ContentInfo, or false if no valid recipients.
     */
    static async encryptGCM(certs, plaintext, options) {
        let keyTransport = (options && options.keyTransport) || 'OAEP';
        let recipients = parseRecipients(certs);

        if (!recipients.length) {
            return false;
        }

        let cek = crypto.randomBytes(32);
        let nonce = crypto.randomBytes(12);

        if (cek.every(b => b === 0) || nonce.every(b => b === 0)) {
            throw new Error('CSPRNG produced all-zero key material');
        }

        try {
            let cipher = crypto.createCipheriv('aes-256-gcm', cek, nonce, { authTagLength: 16 });
            let encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
            let authTag = cipher.getAuthTag();

            let recipientInfoValues = [];
            for (let recip of recipients) {
                if (recip.keyType === 'ec') {
                    recipientInfoValues.push(await buildKeyAgreeRecipientInfo(recip, cek, 'AES-GCM'));
                } else {
                    recipientInfoValues.push(buildKeyTransRecipientInfo(recip, cek, keyTransport));
                }
            }

            // GCMParameters ::= SEQUENCE { aes-nonce OCTET STRING, aes-ICVlen INTEGER DEFAULT 12 }
            let gcmParams = new asn1js.Sequence({
                value: [new asn1js.OctetString({ valueHex: toArrayBuffer(nonce) }), new asn1js.Integer({ value: 16 })]
            });

            let encryptedContentInfo = new asn1js.Sequence({
                value: [
                    new asn1js.ObjectIdentifier({ value: OID_DATA }),
                    new asn1js.Sequence({
                        value: [new asn1js.ObjectIdentifier({ value: OID_AES_256_GCM }), gcmParams]
                    }),
                    new asn1js.Primitive({
                        idBlock: { tagClass: 3, tagNumber: 0 },
                        valueHex: toArrayBuffer(encrypted)
                    })
                ]
            });

            // AuthEnvelopedData ::= SEQUENCE {
            //   version                   INTEGER (0),
            //   recipientInfos            SET OF RecipientInfo,
            //   authEncryptedContentInfo   EncryptedContentInfo,
            //   mac                        OCTET STRING (GCM auth tag)
            // }
            let authEnvelopedData = new asn1js.Sequence({
                value: [
                    new asn1js.Integer({ value: 0 }),
                    new asn1js.Set({ value: recipientInfoValues }),
                    encryptedContentInfo,
                    new asn1js.OctetString({ valueHex: toArrayBuffer(authTag) })
                ]
            });

            let contentInfo = new asn1js.Sequence({
                value: [
                    new asn1js.ObjectIdentifier({ value: OID_AUTH_ENVELOPED_DATA }),
                    new asn1js.Constructed({
                        idBlock: { tagClass: 3, tagNumber: 0 },
                        value: [authEnvelopedData]
                    })
                ]
            });

            return Buffer.from(contentInfo.toBER(false));
        } finally {
            cek.fill(0);
        }
    }

    /**
     * Encrypt plaintext using AES-256-CBC and wrap in CMS EnvelopedData (RFC 5652).
     *
     * Built top-level CMS object:
     * ContentInfo ::= SEQUENCE {
     *   contentType OBJECT IDENTIFIER,         -- id-envelopedData
     *   content     [0] EXPLICIT EnvelopedData
     * }
     *
     * EnvelopedData ::= SEQUENCE {
     *   version               INTEGER,         -- 0 (KeyTrans only) or 2 (with KeyAgree)
     *   recipientInfos        SET OF RecipientInfo,
     *   encryptedContentInfo  EncryptedContentInfo
     * }
     *
     * EncryptedContentInfo.contentEncryptionAlgorithm uses:
     *   id-aes256-CBC with IV as OCTET STRING parameter.
     * @param {string[]} certs - PEM certificate strings
     * @param {Buffer} plaintext - raw message bytes
     * @param {object} [options]
     * @param {string} [options.keyTransport='OAEP'] - RSA key transport: 'PKCS#1 v1.5' or 'OAEP'
     * @returns {Promise<Buffer|false>} DER-encoded CMS ContentInfo, or false if no valid recipients.
     */
    static async encryptCBC(certs, plaintext, options) {
        let keyTransport = (options && options.keyTransport) || 'OAEP';
        let recipients = parseRecipients(certs);

        if (!recipients.length) {
            return false;
        }

        let cek = crypto.randomBytes(32);
        let iv = crypto.randomBytes(16);

        if (cek.every(b => b === 0) || iv.every(b => b === 0)) {
            throw new Error('CSPRNG produced all-zero key material');
        }

        try {
            let cipher = crypto.createCipheriv('aes-256-cbc', cek, iv);
            let encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

            let recipientInfoValues = [];
            for (let recip of recipients) {
                if (recip.keyType === 'ec') {
                    recipientInfoValues.push(await buildKeyAgreeRecipientInfo(recip, cek, 'AES-CBC'));
                } else {
                    recipientInfoValues.push(buildKeyTransRecipientInfo(recip, cek, keyTransport));
                }
            }

            let encryptedContentInfo = new asn1js.Sequence({
                value: [
                    new asn1js.ObjectIdentifier({ value: OID_DATA }),
                    new asn1js.Sequence({
                        value: [new asn1js.ObjectIdentifier({ value: OID_AES_256_CBC }), new asn1js.OctetString({ valueHex: toArrayBuffer(iv) })]
                    }),
                    new asn1js.Primitive({
                        idBlock: { tagClass: 3, tagNumber: 0 },
                        valueHex: toArrayBuffer(encrypted)
                    })
                ]
            });

            // EnvelopedData ::= SEQUENCE {
            //   version               INTEGER (0 or 2),
            //   recipientInfos        SET OF RecipientInfo,
            //   encryptedContentInfo  EncryptedContentInfo
            // }
            let hasKeyAgree = recipientInfoValues.some(ri => ri.idBlock && ri.idBlock.tagClass === 3 && ri.idBlock.tagNumber === 1);
            let envelopedData = new asn1js.Sequence({
                value: [new asn1js.Integer({ value: hasKeyAgree ? 2 : 0 }), new asn1js.Set({ value: recipientInfoValues }), encryptedContentInfo]
            });

            let contentInfo = new asn1js.Sequence({
                value: [
                    new asn1js.ObjectIdentifier({ value: OID_ENVELOPED_DATA }),
                    new asn1js.Constructed({
                        idBlock: { tagClass: 3, tagNumber: 0 },
                        value: [envelopedData]
                    })
                ]
            });

            return Buffer.from(contentInfo.toBER(false));
        } finally {
            cek.fill(0);
        }
    }

    /**
     * Validate that a certificate's public key is a supported type and size for S/MIME.
     * RSA: 2048-4096 bits, modulus divisible by 8.
     * EC: P-256, P-384, or P-521 only.
     * @param {string} pem - PEM-encoded certificate
     * @throws {Error} if the key type or size is unsupported
     */
    static validateCertKey(pem) {
        let pubKey = crypto.createPublicKey(pem);
        let keyType = pubKey.asymmetricKeyType;

        if (keyType === 'rsa') {
            let { modulusLength } = pubKey.asymmetricKeyDetails;
            if (modulusLength % 8 !== 0) {
                throw new Error(`RSA modulus length ${modulusLength} is not divisible by 8`);
            }
            if (modulusLength < 2048) {
                throw new Error(`RSA key too small (${modulusLength} bits, minimum 2048)`);
            }
            if (modulusLength > 4096) {
                throw new Error(`RSA key too large (${modulusLength} bits, maximum 4096)`);
            }
        } else if (keyType === 'ec') {
            let { namedCurve } = pubKey.asymmetricKeyDetails;
            if (!['prime256v1', 'secp384r1', 'secp521r1'].includes(namedCurve)) {
                throw new Error(`unsupported EC curve ${namedCurve}, must be P-256, P-384, or P-521`);
            }
        } else {
            throw new Error(`unsupported key type ${keyType}, must be RSA or EC`);
        }
    }
}

SMIMEEncryptor.CIPHERS = ['AES-CBC', 'AES-GCM'];
SMIMEEncryptor.RSA_KEY_TRANSPORTS = ['PKCS#1 v1.5', 'OAEP'];
Object.defineProperty(SMIMEEncryptor, 'pkcs1v15Available', {
    get: () => pkcs1v15Available,
    set: v => { pkcs1v15Available = v; }
});
SMIMEEncryptor._kdfX963 = kdfX963;

module.exports = SMIMEEncryptor;
