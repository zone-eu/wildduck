'use strict';

// JSContact Card validation (RFC 9553), with the JMAP additions of RFC 9610 3 (the Media blobId).
//
// The structure (types, mandatory properties, enumerated values, the keys of maps and sets) is a JSON
// Schema checked by Ajv; the rules that relate properties to each other (a Name needs full or a
// component, a separator needs isOrdered, members need kind group, localizations are patches that must
// leave a valid Card) are checked in code afterwards. Both report the invalid properties as JSON
// pointers without the leading slash, with "~" and "/" in keys escaped as ~0 and ~1 (RFC 6901), which
// is what a JMAP SetError lists in `properties`.
//
// Unknown properties are kept when their name has the syntax of a registered name (RFC 9553 1.7.4) and
// does not differ only in case from a known name; vendor properties (example.com:name) are kept at any
// level. The reserved name "extra" is never valid (RFC 9553 1.7.3.1).

const Ajv = require('ajv');
const { applyPatch, parsePointer } = require('../jmap/patch');

const VERSION = '1.0';
// most languages of a card's localizations
const MAX_LOCALIZATIONS = 64;
// most JSON octets of card properties all localizations of a card together may patch
const MAX_LOCALIZATION_WORK = 4 * 1024 * 1024;

// RFC 9553 1.8.1 v-extension: a domain like prefix, a colon and a name without controls, '"', '/' and '~'
const V_LABEL = '[A-Za-z0-9\\u0080-\\uffff](?:[A-Za-z0-9\\u0080-\\uffff-]*[A-Za-z0-9\\u0080-\\uffff])?';
const VENDOR = new RegExp(`^${V_LABEL}(?:\\.${V_LABEL})*:[\\t !#-.0-}\\u0080-\\uffff]+$`);
// RFC 9553 1.7.2: the syntax of registered property names
const IANA_NAME = /^[A-Za-z0-9@]+$/;
// RFC 9553 1.4.1 Id
const ID = '^[A-Za-z0-9_-]{1,255}$';
// RFC 9553 1.4.5 UTCDateTime: upper case, "Z", a fraction only when it is not zero and without trailing zeros
const UTC_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d*[1-9])?Z$/;
// RFC 5646 language tag (well formed, not checked against the registry)
const LANGUAGE_TAG =
    /^(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}|[A-Za-z]{4,8})(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*(?:-[Xx](?:-[A-Za-z0-9]{1,8})+)?$|^[Xx](?:-[A-Za-z0-9]{1,8})+$/;
// RFC 3986: a scheme, a colon and no white space or control characters
const URI = '^[A-Za-z][A-Za-z0-9+.-]*:[^\\s\\x00-\\x1f\\x7f]*$';
// RFC 5322 addr-spec, loosely: one "@" with something on both sides, SMTPUTF8 allowed
const ADDR_SPEC = '^[^\\s@\\x00-\\x1f\\x7f]+@[^\\s@\\x00-\\x1f\\x7f]+$';
// control characters free form text may not contain (TAB, LF and CR are allowed)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const ENUMS = {
    cardKind: ['individual', 'group', 'org', 'location', 'device', 'application'],
    nameComponent: ['title', 'given', 'given2', 'surname', 'surname2', 'credential', 'generation', 'separator'],
    addressComponent: [
        'apartment',
        'block',
        'building',
        'country',
        'direction',
        'district',
        'floor',
        'landmark',
        'locality',
        'name',
        'number',
        'postcode',
        'postOfficeBox',
        'region',
        'room',
        'separator',
        'subdistrict'
    ],
    contexts: ['private', 'work'],
    addressContexts: ['private', 'work', 'billing', 'delivery'],
    features: ['fax', 'main-number', 'mobile', 'pager', 'text', 'textphone', 'video', 'voice'],
    grammaticalGender: ['animate', 'common', 'feminine', 'inanimate', 'masculine', 'neuter'],
    anniversary: ['birth', 'death', 'wedding'],
    calendar: ['calendar', 'freeBusy'],
    directory: ['directory', 'entry'],
    link: ['contact'],
    media: ['logo', 'photo', 'sound'],
    title: ['title', 'role'],
    personalInfo: ['expertise', 'hobby', 'interest'],
    level: ['high', 'low', 'medium'],
    phoneticSystem: ['ipa', 'jyut', 'piny'],
    relation: [
        'acquaintance',
        'agent',
        'child',
        'colleague',
        'contact',
        'co-resident',
        'co-worker',
        'crush',
        'date',
        'emergency',
        'friend',
        'kin',
        'me',
        'met',
        'muse',
        'neighbor',
        'parent',
        'sibling',
        'spouse',
        'sweetheart'
    ]
};

// every property name a version of JSContact known here defines, lower cased: an unknown name that
// differs from one of them only in case is invalid (RFC 9553 1.7.1)
const KNOWN_NAMES = new Set();

const ajv = new Ajv({ allErrors: true, strict: false, unicode: false, logger: false });

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const escapeToken = token => String(token).replace(/~/g, '~0').replace(/\//g, '~1');
const isVendor = value => typeof value === 'string' && VENDOR.test(value);

/** A property name that may appear in an object whose known properties are `known` */
function validName(name, known) {
    if (known.has(name) || isVendor(name)) {
        return true;
    }
    return name !== 'extra' && IANA_NAME.test(name) && !KNOWN_NAMES.has(name.toLowerCase());
}

// known property names of each object type, by the list in its schema
const nameSets = new Map();

// the names of an object: known ones, vendor ones and unknown ones of the registered syntax
ajv.addKeyword({
    keyword: 'jsNames',
    errors: true,
    validate: function jsNames(known, data) {
        if (!isObject(data)) {
            return true;
        }
        if (!nameSets.has(known)) {
            nameSets.set(known, new Set(known));
        }
        const bad = Object.keys(data).filter(name => !validName(name, nameSets.get(known)));
        jsNames.errors = bad.map(key => ({ keyword: 'jsNames', message: 'invalid property name', params: { key } }));
        return !bad.length;
    }
});

// an enumerated value (RFC 9553 1.7.5): a registered value or a vendor value
ajv.addKeyword({
    keyword: 'jsEnum',
    validate: (values, data) => typeof data !== 'string' || values.includes(data) || isVendor(data)
});

ajv.addKeyword({
    keyword: 'jsUTCDateTime',
    validate: (enabled, data) => typeof data !== 'string' || isUTCDateTime(data)
});

ajv.addKeyword({
    keyword: 'jsLanguageTag',
    validate: (enabled, data) => typeof data !== 'string' || LANGUAGE_TAG.test(data)
});

ajv.addKeyword({
    keyword: 'jsTimeZone',
    validate: (enabled, data) => typeof data !== 'string' || isTimeZone(data)
});

function isUTCDateTime(value) {
    const match = UTC_DATE_TIME.exec(value);
    if (!match) {
        return false;
    }
    const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]));
    return date.getUTCFullYear() === +match[1] && date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3] && +match[4] < 24;
}

const timeZones = new Map();
/** An IANA time zone name (or alias) the runtime knows */
function isTimeZone(value) {
    if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value) || value.length > 64) {
        return false;
    }
    if (!timeZones.has(value)) {
        let valid = true;
        try {
            valid = !!new Intl.DateTimeFormat('en-US', { timeZone: value });
        } catch {
            valid = false;
        }
        if (timeZones.size < 1000) {
            timeZones.set(value, valid);
        }
        return valid;
    }
    return timeZones.get(value);
}

// ---------------------------------------------------------------- schema

const string = { type: 'string' };
const nonEmpty = { type: 'string', minLength: 1 };
const uri = { type: 'string', pattern: URI };
const pref = { type: 'integer', minimum: 1, maximum: 100 };
const listAs = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const bool = { type: 'boolean' };
const utc = { type: 'string', jsUTCDateTime: true };
const languageTag = { type: 'string', jsLanguageTag: true };
const enumOf = values => ({ type: 'string', jsEnum: values });
// String[Boolean] with true values; keys limited to `keys` when given
const setOf = keys =>
    Object.assign({ type: 'object', additionalProperties: { const: true } }, keys ? { propertyNames: { jsEnum: keys } } : { propertyNames: { minLength: 1 } });
const mapOf = schema => ({ type: 'object', propertyNames: { pattern: ID }, additionalProperties: schema });
const contexts = setOf(ENUMS.contexts);

/**
 * The schema of a JSContact object type.
 *
 * @param {String|null} type the @type value, or null for no @type property
 * @param {Object} properties name -> schema
 * @param {String[]} [required]
 */
function objectType(type, properties, required = []) {
    const all = Object.assign(type ? { '@type': { const: type } } : {}, properties);
    for (const name of Object.keys(all)) {
        KNOWN_NAMES.add(name.toLowerCase());
    }
    return { type: 'object', properties: all, required, jsNames: Object.keys(all) };
}

const resource = (type, kinds, extra = {}, required = ['uri']) =>
    objectType(type, Object.assign({ kind: kinds ? enumOf(kinds) : string, uri, mediaType: string, contexts, pref, label: string }, extra), required);

const nameComponent = objectType('NameComponent', { value: string, kind: enumOf(ENUMS.nameComponent), phonetic: string }, ['value', 'kind']);
const name = objectType('Name', {
    components: { type: 'array', items: nameComponent },
    isOrdered: bool,
    defaultSeparator: string,
    full: string,
    sortAs: { type: 'object', additionalProperties: string },
    phoneticScript: { type: 'string', pattern: '^[A-Za-z]{4}$' },
    phoneticSystem: enumOf(ENUMS.phoneticSystem)
});
const addressComponent = objectType('AddressComponent', { value: string, kind: enumOf(ENUMS.addressComponent), phonetic: string }, ['value', 'kind']);
const address = objectType('Address', {
    components: { type: 'array', items: addressComponent },
    isOrdered: bool,
    countryCode: { type: 'string', pattern: '^[A-Za-z]{2}$' },
    coordinates: { type: 'string', pattern: '^[Gg][Ee][Oo]:[^\\s]+$' },
    timeZone: { type: 'string', jsTimeZone: true },
    contexts: setOf(ENUMS.addressContexts),
    full: string,
    defaultSeparator: string,
    pref,
    phoneticScript: { type: 'string', pattern: '^[A-Za-z]{4}$' },
    phoneticSystem: enumOf(ENUMS.phoneticSystem)
});
const partialDate = objectType('PartialDate', {
    year: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    month: { type: 'integer', minimum: 1, maximum: 12 },
    day: { type: 'integer', minimum: 1, maximum: 31 },
    calendarScale: string
});
const timestamp = objectType('Timestamp', { utc }, ['utc']);
// the Timestamp properties are known names too
KNOWN_NAMES.add('utc');

const cardProperties = {
    version: { type: 'string', const: VERSION },
    created: utc,
    kind: enumOf(ENUMS.cardKind),
    language: languageTag,
    members: setOf(),
    prodId: nonEmpty,
    uid: nonEmpty,
    relatedTo: {
        type: 'object',
        propertyNames: { minLength: 1 },
        additionalProperties: objectType('Relation', { relation: setOf(ENUMS.relation) })
    },
    updated: utc,
    name,
    nicknames: mapOf(objectType('Nickname', { name: string, contexts, pref }, ['name'])),
    organizations: mapOf(
        objectType('Organization', {
            name: string,
            units: { type: 'array', minItems: 1, items: objectType('OrgUnit', { name: string, sortAs: string }, ['name']) },
            sortAs: string,
            contexts
        })
    ),
    speakToAs: objectType('SpeakToAs', {
        grammaticalGender: enumOf(ENUMS.grammaticalGender),
        pronouns: mapOf(objectType('Pronouns', { pronouns: string, contexts, pref }, ['pronouns']))
    }),
    titles: mapOf(objectType('Title', { name: string, kind: enumOf(ENUMS.title), organizationId: { type: 'string', pattern: ID } }, ['name'])),
    emails: mapOf(objectType('EmailAddress', { address: { type: 'string', pattern: ADDR_SPEC }, contexts, pref, label: string }, ['address'])),
    onlineServices: mapOf(objectType('OnlineService', { service: string, uri, user: string, contexts, pref, label: string })),
    phones: mapOf(objectType('Phone', { number: string, features: setOf(ENUMS.features), contexts, pref, label: string }, ['number'])),
    preferredLanguages: mapOf(objectType('LanguagePref', { language: languageTag, contexts, pref }, ['language'])),
    calendars: mapOf(resource('Calendar', ENUMS.calendar, {}, ['uri', 'kind'])),
    schedulingAddresses: mapOf(objectType('SchedulingAddress', { uri, contexts, pref, label: string }, ['uri'])),
    addresses: mapOf(address),
    cryptoKeys: mapOf(resource('CryptoKey', null)),
    directories: mapOf(resource('Directory', ENUMS.directory, { listAs }, ['uri', 'kind'])),
    links: mapOf(resource('Link', ENUMS.link)),
    // uri or blobId (RFC 9610 3), checked in code
    media: mapOf(resource('Media', ENUMS.media, { blobId: { type: 'string', pattern: ID } }, ['kind'])),
    localizations: { type: 'object', propertyNames: { jsLanguageTag: true }, additionalProperties: { type: 'object' } },
    anniversaries: mapOf(objectType('Anniversary', { kind: enumOf(ENUMS.anniversary), date: { type: 'object' }, place: address }, ['kind', 'date'])),
    keywords: setOf(),
    notes: mapOf(objectType('Note', { note: string, created: utc, author: objectType('Author', { name: string, uri }) }, ['note'])),
    personalInfo: mapOf(
        objectType('PersonalInfo', { kind: enumOf(ENUMS.personalInfo), value: string, level: enumOf(ENUMS.level), listAs, label: string }, ['kind', 'value'])
    )
};

// the JMAP properties of a ContactCard (RFC 9610 3) are known names, they are validated by the JMAP layer
for (const jmapName of ['id', 'addressBookIds', 'blobId']) {
    KNOWN_NAMES.add(jmapName.toLowerCase());
}

const cardSchema = objectType('Card', cardProperties, ['@type', 'version', 'uid']);
const validateStructure = ajv.compile(cardSchema);
const validatePartialDate = ajv.compile(partialDate);
const validateTimestamp = ajv.compile(timestamp);

/** The paths of Ajv errors, relative to `base` */
function errorPaths(errors, base = '') {
    const paths = [];
    for (const error of errors || []) {
        let path = error.instancePath;
        if (error.keyword === 'required') {
            path += `/${escapeToken(error.params.missingProperty)}`;
        } else if (error.keyword === 'jsNames') {
            path += `/${escapeToken(error.params.key)}`;
        } else if (error.propertyName !== undefined || error.keyword === 'propertyNames') {
            const key = error.propertyName !== undefined ? error.propertyName : error.params.propertyName;
            // an empty key is reported as the map itself
            path += key === '' ? '' : `/${escapeToken(key)}`;
        }
        paths.push(base + path);
    }
    return paths;
}

// ---------------------------------------------------------------- rules between properties

const entries = value => (isObject(value) ? Object.entries(value) : []);

/** Rules of an ordered list of components (Name and Address) */
function checkComponents(object, path, report) {
    if (!isObject(object)) {
        return;
    }
    const components = Array.isArray(object.components) ? object.components : null;
    if (components) {
        if (!components.some(component => isObject(component) && component.kind !== 'separator')) {
            report(`${path}/components`);
        }
        if (object.isOrdered !== true) {
            components.forEach((component, index) => {
                if (isObject(component) && component.kind === 'separator') {
                    report(`${path}/components/${index}/kind`);
                }
            });
        }
        if (!object.phoneticSystem && !object.phoneticScript) {
            components.forEach((component, index) => {
                if (isObject(component) && component.phonetic !== undefined) {
                    report(`${path}/components/${index}/phonetic`);
                }
            });
        }
    }
    if (object.defaultSeparator !== undefined && object.isOrdered !== true) {
        report(`${path}/defaultSeparator`);
    }
}

function checkName(name, report) {
    if (!isObject(name)) {
        return;
    }
    if (name.full === undefined && name.components === undefined) {
        report('name');
    }
    checkComponents(name, 'name', report);
    if (name.sortAs !== undefined && isObject(name.sortAs)) {
        const kinds = new Set((Array.isArray(name.components) ? name.components : []).filter(isObject).map(component => component.kind));
        const invalid = Object.keys(name.sortAs).some(kind => kind === 'separator' || !ENUMS.nameComponent.includes(kind) || !kinds.has(kind));
        if (!Array.isArray(name.components) || invalid) {
            report('name/sortAs');
        }
    }
}

function checkAddress(address, path, report) {
    if (!isObject(address)) {
        return;
    }
    if (!['components', 'coordinates', 'countryCode', 'full', 'timeZone'].some(property => address[property] !== undefined)) {
        report(path);
    }
    checkComponents(address, path, report);
}

function checkAnniversaryDate(date, path, report) {
    if (!isObject(date)) {
        return;
    }
    if (date['@type'] === undefined && date.utc !== undefined) {
        // the default type is PartialDate, a Timestamp needs its @type (RFC 9553 2.8.1)
        report(path);
        return;
    }
    if (date['@type'] === 'Timestamp') {
        errorPaths(validateTimestamp(date) ? [] : validateTimestamp.errors, path).forEach(report);
        return;
    }
    const before = validatePartialDate(date) ? [] : errorPaths(validatePartialDate.errors, path);
    before.forEach(report);
    if (before.length) {
        return;
    }
    if (date.year === undefined && date.month === undefined && date.day === undefined) {
        report(path);
    } else if (date.day !== undefined && date.month === undefined) {
        report(`${path}/day`);
    } else if (date.month !== undefined && date.year === undefined && date.day === undefined) {
        report(`${path}/month`);
    }
}

function checkMedia(media, options, report) {
    for (const [key, entry] of entries(media)) {
        if (!isObject(entry)) {
            continue;
        }
        const path = `media/${escapeToken(key)}`;
        if (entry.uri !== undefined && entry.blobId !== undefined) {
            report(path);
        } else if (entry.uri === undefined && entry.blobId === undefined) {
            report(`${path}/uri`);
        } else if (entry.blobId !== undefined && !options.blobIds) {
            report(`${path}/blobId`);
        }
    }
}

/** Free form text of registered properties without control characters, vendor properties aside */
function checkText(value, path, report, depth = 0) {
    if (typeof value === 'string') {
        if (CONTROL.test(value)) {
            report(path);
        }
        return;
    }
    if (depth > 16 || value === null || typeof value !== 'object') {
        return;
    }
    for (const [key, child] of Array.isArray(value) ? value.entries() : Object.entries(value)) {
        if (!isVendor(key)) {
            checkText(child, `${path}/${escapeToken(key)}`, report, depth + 1);
        }
    }
}

/** Rules Ajv does not express, on a card whose structure may be invalid */
function checkRules(card, options, report) {
    checkName(card.name, report);
    for (const [key, organization] of entries(card.organizations)) {
        if (isObject(organization) && organization.name === undefined && organization.units === undefined) {
            report(`organizations/${escapeToken(key)}`);
        }
    }
    if (isObject(card.speakToAs) && card.speakToAs.grammaticalGender === undefined && card.speakToAs.pronouns === undefined) {
        report('speakToAs');
    }
    for (const [key, service] of entries(card.onlineServices)) {
        if (isObject(service) && service.uri === undefined && service.user === undefined) {
            report(`onlineServices/${escapeToken(key)}`);
        }
    }
    for (const [key, address] of entries(card.addresses)) {
        checkAddress(address, `addresses/${escapeToken(key)}`, report);
    }
    for (const [key, anniversary] of entries(card.anniversaries)) {
        if (isObject(anniversary)) {
            checkAnniversaryDate(anniversary.date, `anniversaries/${escapeToken(key)}/date`, report);
            checkAddress(anniversary.place, `anniversaries/${escapeToken(key)}/place`, report);
        }
    }
    for (const [key, note] of entries(card.notes)) {
        if (isObject(note) && isObject(note.author) && note.author.name === undefined && note.author.uri === undefined) {
            report(`notes/${escapeToken(key)}/author`);
        }
    }
    if (card.members !== undefined && card.kind !== 'group') {
        report('members');
    }
    checkMedia(card.media, options, report);
    for (const [key, value] of Object.entries(card)) {
        if (!isVendor(key) && key !== 'localizations') {
            checkText(value, escapeToken(key), report);
        }
    }
}

// ---------------------------------------------------------------- localizations

/** The tokens of a patch path, or null when it is not a valid path (RFC 9553 1.4.3) */
function patchTokens(key) {
    try {
        return parsePointer(key);
    } catch {
        return null;
    }
}

/** A JSContact PatchObject applied to a copy of an object ({object, properties}), or null when it can not be applied */
function applyCardPatch(object, patch) {
    try {
        return applyPatch(object, patch, { arrays: true });
    } catch {
        return null;
    }
}

// a localized card is validated only in the top level properties its patch touched, plus these (the
// mandatory ones, and kind, which decides whether members are allowed)
const LOCALIZED_ALWAYS = ['@type', 'version', 'uid', 'kind'];

/**
 * The part of a patched card a localization has to be checked in: the touched top level properties and
 * the ones the rules relate them to. The others are those of the card itself, already validated.
 */
function localizedPart(patched, touched) {
    const keys = new Set([...LOCALIZED_ALWAYS, ...touched]);
    if (touched.has('kind') || touched.has('members')) {
        keys.add('members');
    }
    const part = {};
    for (const key of keys) {
        if (Object.hasOwn(patched, key)) {
            Object.defineProperty(part, key, { value: patched[key], enumerable: true, writable: true, configurable: true });
        }
    }
    return part;
}

function checkLocalizations(card, options, report, baseErrors) {
    if (!isObject(card.localizations)) {
        return;
    }
    const languages = Object.entries(card.localizations);
    if (languages.length > MAX_LOCALIZATIONS) {
        // every localization is validated as a card of its own, so their number is bounded
        report('localizations');
        return;
    }
    const base = Object.assign({}, card);
    delete base.localizations;
    // JSON octets of the card properties the localizations touch, which are validated once per localization
    const sizes = new Map();
    const sizeOf = key => {
        if (!sizes.has(key)) {
            sizes.set(key, Object.hasOwn(base, key) ? (JSON.stringify(base[key]) || '').length : 0);
        }
        return sizes.get(key);
    };
    let work = 0;
    for (const [language, patch] of languages) {
        const path = `localizations/${escapeToken(language)}`;
        if (!isObject(patch)) {
            continue;
        }
        const keys = Object.keys(patch);
        const targets = keys.map(key => ({ key, tokens: patchTokens(key) }));
        if (targets.some(target => target.tokens && target.tokens[0] === 'localizations')) {
            targets.filter(target => target.tokens && target.tokens[0] === 'localizations').forEach(target => report(`${path}/${escapeToken(target.key)}`));
            continue;
        }
        const patched = applyCardPatch(base, patch);
        if (!patched) {
            report(path);
            continue;
        }
        for (const key of patched.properties) {
            work += sizeOf(key);
        }
        if (work > MAX_LOCALIZATION_WORK) {
            report('localizations');
            return;
        }
        const invalid = validateCard(localizedPart(patched.object, patched.properties), Object.assign({}, options, { localized: true })).filter(
            invalidPath => !baseErrors.has(invalidPath)
        );
        for (const invalidPath of invalid) {
            // the patch that set the invalid value, or the whole localization
            const target = targets.find(
                target =>
                    target.tokens &&
                    (`${invalidPath}/`.startsWith(`${target.tokens.map(escapeToken).join('/')}/`) ||
                        target.tokens.map(escapeToken).join('/').startsWith(`${invalidPath}/`))
            );
            report(target ? `${path}/${escapeToken(target.key)}` : path);
        }
    }
}

/**
 * Validates a JSContact Card.
 *
 * @param {Object} card the Card, without the JMAP id and addressBookIds
 * @param {Object} [options]
 * @param {Boolean} [options.blobIds] Media may name a blob with blobId (RFC 9610 3)
 * @returns {String[]} the invalid properties as JSON pointers without the leading slash, empty when the card is valid
 */
function validateCard(card, options = {}) {
    if (!isObject(card)) {
        return [''];
    }
    const paths = new Set();
    const report = path => paths.add(path.replace(/^\//, ''));
    if (!validateStructure(card)) {
        errorPaths(validateStructure.errors).forEach(report);
    }
    checkRules(card, options, report);
    if (!options.localized) {
        checkLocalizations(card, options, report, new Set(paths));
    }
    return [...paths];
}

module.exports = { validateCard, escapeToken, isVendor, isUTCDateTime, ENUMS, VERSION, NAME_KINDS: ENUMS.nameComponent };
