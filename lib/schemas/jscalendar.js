'use strict';

// JSCalendar validation (RFC 8984 as revised by draft-ietf-calext-jscalendarbis-22) for the Event
// object type, with the properties draft-ietf-jmap-calendars-33 adds for CalendarEvent (section 5).
//
// The structure is a JSON Schema for Ajv; the rules JSON Schema can not express (time zone ids,
// property names and their case, and the dependencies between properties) are checked in code. The
// validator never changes the object: no defaults are filled in, unknown and vendor-specific
// properties are preserved (bis 1.7.4, 1.8.1).
//
// Usable by any front end; JMAP uses it through lib/jmap/types/calendar.js (default alerts) and the
// CalendarEvent methods.

const Ajv = require('ajv');

// ---------------------------------------------------------------- primitive types (bis 1.5)

const ID = /^[A-Za-z0-9_-]{1,255}$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const DUR_TIME = 'T(?:\\d+H(?:\\d+M(?:\\d+S)?)?|\\d+M(?:\\d+S)?|\\d+S)';
const DUR_CAL = '(?:\\d+W(?:\\d+D)?|\\d+D)';
const DURATION = new RegExp(`^P(?:${DUR_CAL}(?:${DUR_TIME})?|${DUR_TIME})$`);
const SIGNED_DURATION = new RegExp(`^[+-]?P(?:${DUR_CAL}(?:${DUR_TIME})?|${DUR_TIME})$`);
const MAX_DURATION_LENGTH = 64;
const MAX_INT = Number.MAX_SAFE_INTEGER;

// a property name as registered at IANA (bis 1.7.2): lower camel case of ALPHA, DIGIT and "@"
const IANA_NAME = /^@?[a-z][A-Za-z0-9@]*$/;
// v-extension (bis 1.8.1): a domain like prefix, a colon and a name without CTLs, DQUOTE, "/" and "~"
const V_LABEL = '[A-Za-z0-9\\u0080-\\uffff](?:[A-Za-z0-9\\u0080-\\uffff-]*[A-Za-z0-9\\u0080-\\uffff])?';
const V_EXTENSION = new RegExp(`^${V_LABEL}(?:\\.${V_LABEL})*:[\\t \\x21\\x23-\\x2e\\x30-\\x7d\\u0080-\\uffff]+$`);
// properties no JSCalendar object may carry: "extra" (bis 1.7.3.1); "excluded" only in an override patch
const RESERVED = new Set(['extra', 'excluded']);

// eslint-disable-next-line no-control-regex
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\x00-\x1f\x7f"<>\\^`{|}]*$/;
// eslint-disable-next-line no-control-regex
const ADDR_SPEC = /^[^\s\x00-\x1f\x7f<>(),;:"[\]\\@]+@[^\s\x00-\x1f\x7f<>(),;:"[\]\\@]+$/;
const LANGUAGE_TAG = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;
const TEXT_MEDIA_TYPE = /^text\/[A-Za-z0-9!#$&^_.+-]{1,127}((?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[^"]*"))*)\s*$/i;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,127}\/[A-Za-z0-9!#$&^_.+-]{1,127}(?:\s*;.*)?$/;
const LINK_RELATION = /^(?:[a-z][a-z0-9.-]*|[A-Za-z][A-Za-z0-9+.-]*:\S+)$/;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const SHORT_HEX_COLOR = /^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

// CSS Color Module Level 3, 4.3: the extended color keywords
const CSS_COLORS = new Set(
    (
        'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse ' +
        'chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta ' +
        'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
        'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green ' +
        'greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
        'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey ' +
        'lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
        'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive ' +
        'olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
        'red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
        'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
    ).split(' ')
);

// CLDR calendar system names (RFC 7529 RSCALE, lowercase)
const RSCALES = new Set([
    'buddhist',
    'chinese',
    'coptic',
    'dangi',
    'ethioaa',
    'ethiopic',
    'gregorian',
    'hebrew',
    'indian',
    'islamic',
    'islamic-civil',
    'islamic-rgsa',
    'islamic-tbla',
    'islamic-umalqura',
    'iso8601',
    'japanese',
    'persian',
    'roc'
]);

const DAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];

const isLeapYear = year => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

function validDateTime(value, utc) {
    if (typeof value !== 'string' || value.length !== (utc ? 20 : 19) || (utc && !value.endsWith('Z'))) {
        return false;
    }
    const match = DATE_TIME.exec(utc ? value.slice(0, -1) : value);
    if (!match) {
        return false;
    }
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 60) {
        return false;
    }
    // the last day of the month, in the proleptic Gregorian calendar
    return day <= new Date(Date.UTC(2000, month, 0)).getUTCDate() - (month === 2 && !isLeapYear(year) ? 1 : 0);
}

/** UTCDateTime (bis 1.5.4): uppercase, "Z", no fractional seconds */
const isUTCDateTime = value => validDateTime(value, true);

/** LocalDateTime (bis 1.5.5) */
const isLocalDateTime = value => validDateTime(value, false);

/** Duration (bis 1.5.6) */
const isDuration = value => typeof value === 'string' && value.length <= MAX_DURATION_LENGTH && DURATION.test(value);

/** SignedDuration (bis 1.5.7) */
const isSignedDuration = value => typeof value === 'string' && value.length <= MAX_DURATION_LENGTH && SIGNED_DURATION.test(value);

/** Id (bis 1.5.1) */
const isId = value => typeof value === 'string' && ID.test(value);

const timeZoneCache = new Map();
const TIME_ZONE_CACHE_SIZE = 2000;

/**
 * TimeZoneId (bis 1.5.8): a name of the IANA Time Zone Database, as the runtime's ICU data knows it,
 * in its exact case. Offsets ("+02:00") and POSIX TZ strings are not names and are refused.
 */
function isTimeZoneId(value) {
    if (typeof value !== 'string' || value.length > 64 || !/^[A-Z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9][A-Za-z0-9_+-]*)*$/.test(value)) {
        return false;
    }
    if (timeZoneCache.has(value)) {
        return timeZoneCache.get(value);
    }
    let valid = false;
    try {
        const resolved = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
        // ICU accepts any case; a canonical name must be given exactly as it is spelled (bis 1.7.1)
        valid = resolved === value || resolved.toLowerCase() !== value.toLowerCase();
    } catch {
        valid = false;
    }
    if (timeZoneCache.size >= TIME_ZONE_CACHE_SIZE) {
        timeZoneCache.clear();
    }
    timeZoneCache.set(value, valid);
    return valid;
}

/**
 * A CSS Color Level 3 color: a color keyword (any case) or an RGB value in hexadecimal notation.
 *
 * @param {*} value
 * @param {Object} [options] {short: true also allows the three digit form "#0af"}
 */
function isColor(value, options = {}) {
    if (typeof value !== 'string') {
        return false;
    }
    if (value.startsWith('#')) {
        return (options.short ? SHORT_HEX_COLOR : HEX_COLOR).test(value);
    }
    return CSS_COLORS.has(value.toLowerCase());
}

/** A vendor-specific property name or value (bis 1.8) */
const isVendorValue = value => typeof value === 'string' && value.length <= 255 && V_EXTENSION.test(value);

function isTextMediaType(value) {
    const match = typeof value === 'string' && value.length <= 255 && TEXT_MEDIA_TYPE.exec(value);
    if (!match) {
        return false;
    }
    // bis 3.2.3: a charset parameter, if any, is utf-8
    const charset = /;\s*charset\s*=\s*"?([^";\s]*)"?/i.exec(match[1] || '');
    return !charset || charset[1].toLowerCase() === 'utf-8';
}

// ---------------------------------------------------------------- schema

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false, coerceTypes: false, unicode: false, logger: false });
const FORMATS = {
    'jscal-id': isId,
    'jscal-utc': isUTCDateTime,
    'jscal-local': isLocalDateTime,
    'jscal-duration': isDuration,
    'jscal-signed-duration': isSignedDuration,
    'jscal-timezone': isTimeZoneId,
    'jscal-color': value => isColor(value),
    'jscal-uri': value => typeof value === 'string' && value.length <= 8192 && URI.test(value),
    'jscal-addr-spec': value => typeof value === 'string' && value.length <= 512 && ADDR_SPEC.test(value),
    'jscal-language': value => typeof value === 'string' && value.length <= 64 && LANGUAGE_TAG.test(value),
    'jscal-text-media-type': isTextMediaType,
    'jscal-media-type': value => typeof value === 'string' && value.length <= 255 && MEDIA_TYPE.test(value),
    'jscal-link-relation': value => typeof value === 'string' && value.length <= 255 && LINK_RELATION.test(value),
    'jscal-rscale': value => typeof value === 'string' && (RSCALES.has(value) || isVendorValue(value)),
    'jscal-by-month': value => typeof value === 'string' && /^(?:[1-9]|1[0-3])L?$/.test(value),
    'jscal-property-name': value => validPropertyName(value)
};
for (const [name, validate] of Object.entries(FORMATS)) {
    ajv.addFormat(name, { type: 'string', validate });
}

const str = { type: 'string' };
const bool = { type: 'boolean' };
const format = name => ({ type: 'string', format: name });
const int = (minimum = -MAX_INT, maximum = MAX_INT) => ({ type: 'integer', minimum, maximum });
const uint = (maximum = MAX_INT) => int(0, maximum);
const trueSet = (keyFormat, extra = {}) =>
    Object.assign({ type: 'object', additionalProperties: { const: true } }, keyFormat ? { propertyNames: format(keyFormat) } : {}, extra);
// an enumeration that also takes registered and vendor-specific values (bis 1.7.5, 1.8.2)
const openEnum = values => ({ anyOf: [{ enum: values }, format('jscal-vendor')] });
const openEnumSet = values => ({ type: 'object', propertyNames: openEnum(values), additionalProperties: { const: true } });
const idMap = ref => ({ type: 'object', propertyNames: format('jscal-id'), additionalProperties: { $ref: ref } });
const array = (items, maxItems = 1000) => ({ type: 'array', minItems: 1, maxItems, items });
ajv.addFormat('jscal-vendor', { type: 'string', validate: isVendorValue });

/** A JSCalendar object type: known properties, any other valid property name, an optional "@type" */
const objectType = (type, properties, required = []) => ({
    type: 'object',
    properties: Object.assign({ '@type': { const: type } }, properties),
    required,
    propertyNames: format('jscal-property-name')
});

const TYPES = {
    Relation: objectType('Relation', { relation: openEnumSet(['first', 'next', 'child', 'parent', 'snooze']) }),
    Link: objectType(
        'Link',
        {
            href: format('jscal-uri'),
            // JMAP Calendars 5.3: an attachment may name a blob of the account instead of an href
            blobId: format('jscal-id'),
            contentType: format('jscal-media-type'),
            size: uint(),
            rel: format('jscal-link-relation'),
            display: openEnumSet(['badge', 'graphic', 'fullsize', 'thumbnail']),
            title: str
        },
        []
    ),
    Location: objectType('Location', {
        name: str,
        locationTypes: trueSet(null),
        coordinates: { type: 'string', pattern: '^[Gg][Ee][Oo]:' },
        links: Object.assign(idMap('#/$defs/Link'), { minProperties: 1 })
    }),
    VirtualLocation: objectType(
        'VirtualLocation',
        {
            name: str,
            uri: format('jscal-uri'),
            features: openEnumSet(['audio', 'chat', 'feed', 'moderator', 'phone', 'screen', 'video'])
        },
        ['uri']
    ),
    NDay: objectType('NDay', { day: { enum: DAYS }, nthOfPeriod: { allOf: [int(), { not: { const: 0 } }] } }, ['day']),
    RecurrenceRule: objectType(
        'RecurrenceRule',
        {
            frequency: { enum: ['yearly', 'monthly', 'weekly', 'daily', 'hourly', 'minutely', 'secondly'] },
            interval: int(1),
            rscale: format('jscal-rscale'),
            skip: { enum: ['omit', 'backward', 'forward'] },
            firstDayOfWeek: { enum: DAYS },
            byDay: array({ $ref: '#/$defs/NDay' }),
            byMonthDay: array({ allOf: [int(-31, 31), { not: { const: 0 } }] }),
            byMonth: array(format('jscal-by-month')),
            byYearDay: array({ allOf: [int(-366, 366), { not: { const: 0 } }] }),
            byWeekNo: array({ allOf: [int(-53, 53), { not: { const: 0 } }] }),
            byHour: array(uint(23)),
            byMinute: array(uint(59)),
            bySecond: array(uint(60)),
            bySetPosition: array({ allOf: [int(), { not: { const: 0 } }] }),
            count: uint(),
            until: format('jscal-local')
        },
        ['frequency']
    ),
    Participant: objectType('Participant', {
        name: str,
        email: format('jscal-addr-spec'),
        description: str,
        descriptionContentType: format('jscal-text-media-type'),
        calendarAddress: format('jscal-uri'),
        kind: openEnum(['individual', 'group', 'location', 'resource']),
        roles: Object.assign(openEnumSet(['owner', 'optional', 'informational', 'chair', 'required']), { minProperties: 1 }),
        participationStatus: openEnum(['needs-action', 'accepted', 'declined', 'tentative', 'delegated']),
        expectReply: bool,
        sentBy: format('jscal-addr-spec'),
        delegatedTo: trueSet('jscal-uri', { minProperties: 1 }),
        delegatedFrom: trueSet('jscal-uri', { minProperties: 1 }),
        memberOf: trueSet('jscal-uri', { minProperties: 1 }),
        links: Object.assign(idMap('#/$defs/Link'), { minProperties: 1 }),
        // JMAP Calendars 5.2
        scheduleSequence: uint(),
        scheduleUpdated: format('jscal-utc')
    }),
    // trigger: OffsetTrigger (the default type), AbsoluteTrigger, or an UnknownTrigger with its own @type
    Trigger: {
        type: 'object',
        propertyNames: format('jscal-property-name'),
        if: { not: { required: ['@type'] } },
        then: { $ref: '#/$defs/OffsetTrigger' },
        else: {
            if: { properties: { '@type': { const: 'OffsetTrigger' } } },
            then: { $ref: '#/$defs/OffsetTrigger' },
            else: {
                if: { properties: { '@type': { const: 'AbsoluteTrigger' } } },
                then: { properties: { when: format('jscal-utc') }, required: ['when'] },
                else: { properties: { '@type': str } }
            }
        }
    },
    OffsetTrigger: { properties: { offset: format('jscal-signed-duration'), relativeTo: { enum: ['start', 'end'] } }, required: ['offset'] },
    Alert: objectType(
        'Alert',
        {
            trigger: { $ref: '#/$defs/Trigger' },
            acknowledged: format('jscal-utc'),
            relatedTo: { type: 'object', additionalProperties: { $ref: '#/$defs/Relation' } },
            action: openEnum(['display', 'email'])
        },
        ['trigger']
    )
};

const EVENT_PROPERTIES = {
    // bis 3.1
    uid: { type: 'string', minLength: 1, maxLength: 1024 },
    version: { enum: ['1.0', '2.0'] },
    relatedTo: { type: 'object', additionalProperties: { $ref: '#/$defs/Relation' } },
    prodId: str,
    created: format('jscal-utc'),
    updated: format('jscal-utc'),
    sequence: uint(),
    method: { type: 'string', pattern: '^[a-z]+$' },
    // bis 3.2
    title: str,
    description: str,
    descriptionContentType: format('jscal-text-media-type'),
    showWithoutTime: bool,
    locations: idMap('#/$defs/Location'),
    mainLocationId: format('jscal-id'),
    virtualLocations: idMap('#/$defs/VirtualLocation'),
    links: idMap('#/$defs/Link'),
    locale: format('jscal-language'),
    keywords: trueSet(null),
    categories: trueSet('jscal-uri'),
    color: format('jscal-color'),
    // bis 3.3
    recurrenceId: format('jscal-local'),
    recurrenceIdTimeZone: format('jscal-timezone'),
    recurrenceRule: { $ref: '#/$defs/RecurrenceRule' },
    recurrenceOverrides: { type: 'object', propertyNames: format('jscal-local'), additionalProperties: { type: 'object' } },
    // bis 3.4
    priority: int(0, 9),
    freeBusyStatus: openEnum(['free', 'busy']),
    privacy: openEnum(['public', 'private', 'secret']),
    organizerCalendarAddress: format('jscal-uri'),
    sentBy: format('jscal-addr-spec'),
    participants: idMap('#/$defs/Participant'),
    // bis 3.5, 3.6
    alerts: idMap('#/$defs/Alert'),
    timeZone: format('jscal-timezone'),
    // bis 4.1
    start: format('jscal-local'),
    duration: format('jscal-duration'),
    endTimeZone: format('jscal-timezone'),
    status: openEnum(['confirmed', 'cancelled', 'tentative']),
    // JMAP Calendars 5 and 5.1
    id: format('jscal-id'),
    baseEventId: { anyOf: [format('jscal-id'), { type: 'null' }] },
    calendarIds: trueSet('jscal-id'),
    isDraft: bool,
    isOrigin: bool,
    useDefaultAlerts: bool,
    utcStart: format('jscal-utc'),
    utcEnd: format('jscal-utc'),
    mayInviteSelf: bool,
    mayInviteOthers: bool,
    hideAttendees: bool
};

TYPES.Event = objectType('Event', EVENT_PROPERTIES);

// every name some object type defines: a name that differs from one of them only in case is invalid (bis 1.7.1)
const KNOWN_NAMES = new Map();
for (const definition of Object.values(TYPES)) {
    for (const name of Object.keys(definition.properties || {})) {
        KNOWN_NAMES.set(name.toLowerCase(), name);
    }
}

function validPropertyName(name) {
    if (typeof name !== 'string' || RESERVED.has(name)) {
        return false;
    }
    const known = KNOWN_NAMES.get(name.toLowerCase());
    if (known) {
        return known === name;
    }
    return IANA_NAME.test(name) || isVendorValue(name);
}

const validators = {
    Event: ajv.compile({ $defs: TYPES, $ref: '#/$defs/Event' }),
    Alert: ajv.compile({ $defs: TYPES, $ref: '#/$defs/Alert' })
};

// ---------------------------------------------------------------- rules beyond the schema

// participant properties that need calendarAddress (bis 3.4.6)
const NEEDS_CALENDAR_ADDRESS = ['email', 'kind', 'roles', 'participationStatus', 'expectReply', 'sentBy', 'delegatedTo', 'delegatedFrom', 'memberOf'];
// pointers an override patch may not set (bis 3.3.4); "*" is any token
const OVERRIDE_FORBIDDEN = [
    '@type',
    'method',
    'organizerCalendarAddress',
    'participants/*/calendarAddress',
    'privacy',
    'prodId',
    'recurrenceId',
    'recurrenceIdTimeZone',
    'sentBy',
    'uid',
    // JMAP Calendars 5 and 5.1: base object only
    'isDraft',
    'mayInviteSelf',
    'mayInviteOthers',
    'hideAttendees'
].map(pointer => pointer.split('/'));
const OVERRIDE_FORBIDDEN_FIRST = new Set(['recurrenceOverrides', 'recurrenceRule']);

const own = (object, key) => object !== null && typeof object === 'object' && Object.hasOwn(object, key);

function participantProblems(participants, problems) {
    for (const [id, participant] of Object.entries(participants || {})) {
        if (participant === null || typeof participant !== 'object') {
            continue;
        }
        const path = `participants/${id}`;
        if (!own(participant, 'calendarAddress')) {
            for (const property of NEEDS_CALENDAR_ADDRESS.filter(name => own(participant, name))) {
                problems.push({ path: `${path}/${property}`, message: `${property} requires calendarAddress` });
            }
        }
        if (own(participant, 'descriptionContentType') && !own(participant, 'description')) {
            problems.push({ path: `${path}/descriptionContentType`, message: 'descriptionContentType requires description' });
        }
        // progress and percentComplete belong to the participants of a Task (bis 3.4.6)
        for (const property of ['progress', 'percentComplete'].filter(name => own(participant, name))) {
            problems.push({ path: `${path}/${property}`, message: `${property} is only defined for a Task` });
        }
    }
}

function linkProblems(links, path, problems) {
    for (const [id, link] of Object.entries(links || {})) {
        if (link === null || typeof link !== 'object') {
            continue;
        }
        if (!own(link, 'href') && !own(link, 'blobId')) {
            problems.push({ path: `${path}/${id}/href`, message: 'a link needs href or blobId' });
        }
        if (own(link, 'display') && link.rel !== 'icon') {
            problems.push({ path: `${path}/${id}/display`, message: 'display requires rel "icon"' });
        }
    }
}

function recurrenceProblems(event, problems) {
    const rule = event.recurrenceRule;
    if (rule && typeof rule === 'object') {
        if (own(rule, 'count') && own(rule, 'until')) {
            problems.push({ path: 'recurrenceRule/until', message: 'count and until are mutually exclusive' });
        }
        const gregorian = !own(rule, 'rscale') || rule.rscale === 'gregorian';
        if (gregorian && Array.isArray(rule.byMonth) && rule.byMonth.some(month => typeof month === 'string' && (month.endsWith('L') || Number(month) > 12))) {
            problems.push({ path: 'recurrenceRule/byMonth', message: 'the Gregorian calendar has twelve months and no leap months' });
        }
    }
    if (own(event, 'recurrenceId') && (own(event, 'recurrenceRule') || own(event, 'recurrenceOverrides'))) {
        problems.push({ path: 'recurrenceId', message: 'an occurrence has no recurrenceRule or recurrenceOverrides' });
    }
    if (own(event, 'recurrenceIdTimeZone') && !own(event, 'recurrenceId')) {
        problems.push({ path: 'recurrenceIdTimeZone', message: 'recurrenceIdTimeZone requires recurrenceId' });
    }
    for (const [recurrenceId, patch] of Object.entries(event.recurrenceOverrides || {})) {
        for (const problem of overrideProblems(patch)) {
            problems.push({ path: `recurrenceOverrides/${recurrenceId}`, message: problem });
        }
    }
}

const matchesPointer = (rule, tokens) => rule.length === tokens.length && rule.every((token, i) => token === '*' || token === tokens[i]);

/**
 * The problems of one recurrenceOverrides patch (bis 1.5.9, 3.3.4): an exclusion is exactly
 * {excluded: true}; no pointer may set a property that only the base object has.
 */
function overrideProblems(patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        return ['an override is a PatchObject'];
    }
    const keys = Object.keys(patch);
    if (own(patch, 'excluded')) {
        return keys.length === 1 && patch.excluded === true ? [] : ['an exclusion is exactly {"excluded": true}'];
    }
    const problems = [];
    const tokenLists = [];
    for (const key of keys) {
        const tokens = typeof key === 'string' && key.length && !key.startsWith('/') ? key.split('/') : null;
        if (!tokens || tokens.some(token => !token.length || token === '-' || /~(?![01])/.test(token))) {
            problems.push(`invalid pointer ${JSON.stringify(key)}`);
            continue;
        }
        const decoded = tokens.map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
        if (OVERRIDE_FORBIDDEN_FIRST.has(decoded[0]) || OVERRIDE_FORBIDDEN.some(rule => matchesPointer(rule, decoded))) {
            problems.push(`${key} can not be overridden`);
        }
        if (decoded.length === 1 && !RESERVED.has(decoded[0]) && !validPropertyName(decoded[0])) {
            problems.push(`invalid property name ${JSON.stringify(key)}`);
        }
        tokenLists.push(decoded);
    }
    // no pointer may be a prefix of another
    const seen = new Set(tokenLists.map(tokens => JSON.stringify(tokens)));
    if (tokenLists.some(tokens => tokens.some((token, i) => i > 0 && seen.has(JSON.stringify(tokens.slice(0, i)))))) {
        problems.push('overlapping pointers');
    }
    return problems;
}

function crossProblems(event, options) {
    const problems = [];
    if (own(event, 'endTimeZone') && !own(event, 'timeZone')) {
        problems.push({ path: 'endTimeZone', message: 'endTimeZone requires timeZone' });
    }
    if (own(event, 'mainLocationId')) {
        const location = own(event.locations, event.mainLocationId) ? event.locations[event.mainLocationId] : null;
        if (!location || typeof location.name !== 'string') {
            problems.push({ path: 'mainLocationId', message: 'mainLocationId must name a location that has a name' });
        }
    }
    for (const [id, location] of Object.entries(event.locations || {})) {
        if (location && typeof location === 'object' && !Object.keys(location).some(key => key !== '@type')) {
            problems.push({ path: `locations/${id}`, message: 'a location needs a property besides @type' });
        }
        if (location && typeof location === 'object') {
            linkProblems(location.links, `locations/${id}/links`, problems);
        }
    }
    linkProblems(event.links, 'links', problems);
    const participants = event.participants && typeof event.participants === 'object' ? Object.values(event.participants) : [];
    const addressed = participants.some(participant => own(participant, 'calendarAddress'));
    if (addressed && !own(event, 'organizerCalendarAddress')) {
        problems.push({ path: 'organizerCalendarAddress', message: 'participants with a calendarAddress require organizerCalendarAddress' });
    }
    if (own(event, 'organizerCalendarAddress') && !addressed) {
        problems.push({ path: 'participants', message: 'organizerCalendarAddress requires a participant with a calendarAddress' });
    }
    if (own(event, 'sentBy') && !own(event, 'organizerCalendarAddress')) {
        problems.push({ path: 'sentBy', message: 'sentBy requires organizerCalendarAddress' });
    }
    participantProblems(event.participants, problems);
    recurrenceProblems(event, problems);
    if (options.stored && own(event, 'method')) {
        // JMAP Calendars 5: a stored event has no iTIP method
        problems.push({ path: 'method', message: 'a stored event has no method' });
    }
    return problems;
}

// "/a/b~1c" (Ajv instancePath) to "a/b~1c"
const pathOf = error => {
    const base = error.instancePath.replace(/^\//, '');
    if (error.keyword === 'propertyNames' || (error.params && error.params.propertyName !== undefined)) {
        const name = error.params.propertyName.replace(/~/g, '~0').replace(/\//g, '~1');
        return base ? `${base}/${name}` : name;
    }
    if (error.keyword === 'required') {
        return base ? `${base}/${error.params.missingProperty}` : error.params.missingProperty;
    }
    return base;
};

/** The top level property of a path ("participants/p1/email" is participants) */
const topProperty = path => path.split('/')[0].replace(/~1/g, '/').replace(/~0/g, '~');

function result(problems) {
    const properties = [...new Set(problems.map(problem => topProperty(problem.path)))];
    return { valid: problems.length === 0, problems, properties };
}

function schemaProblems(validator, value) {
    if (validator(value)) {
        return [];
    }
    // a failed propertyNames check is reported twice by Ajv, once per keyword
    const seen = new Set();
    return validator.errors
        .map(error => ({ path: pathOf(error), message: error.message }))
        .filter(problem => (problem.path && !seen.has(problem.path) ? seen.add(problem.path) : false));
}

/**
 * Validates a JSCalendar Event.
 *
 * @param {Object} event
 * @param {Object} [options]
 * @param {Boolean} [options.mandatory] require the mandatory properties of a stand alone Event (@type, uid, updated, start)
 * @param {Boolean} [options.stored] the event is stored (JMAP CalendarEvent): no iTIP method
 * @returns {{valid: Boolean, problems: Array<{path: String, message: String}>, properties: String[]}} properties
 *   are the top level properties that have a problem, as a JMAP invalidProperties SetError names them
 */
function validateEvent(event, options = {}) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
        return result([{ path: '', message: 'an Event is an object' }]);
    }
    const problems = schemaProblems(validators.Event, event);
    if (options.mandatory) {
        for (const property of ['@type', 'uid', 'updated', 'start'].filter(name => !own(event, name))) {
            problems.push({ path: property, message: `${property} is mandatory` });
        }
    }
    problems.push(...crossProblems(event, options));
    return result(problems.filter(problem => problem.path !== ''));
}

/**
 * Validates an Alert (bis 3.5.1).
 *
 * @param {Object} alert
 * @param {Object} [options] {absolute: false refuses an AbsoluteTrigger, as for default alerts (JMAP Calendars 4)}
 * @returns {{valid: Boolean, problems: Array<{path: String, message: String}>}}
 */
function validateAlert(alert, options = {}) {
    if (alert === null || typeof alert !== 'object' || Array.isArray(alert)) {
        return result([{ path: '', message: 'an Alert is an object' }]);
    }
    const problems = schemaProblems(validators.Alert, alert);
    if (options.absolute === false && alert.trigger && alert.trigger['@type'] === 'AbsoluteTrigger') {
        problems.push({ path: 'trigger', message: 'an AbsoluteTrigger is not allowed here' });
    }
    return { valid: problems.length === 0, problems };
}

module.exports = {
    validateEvent,
    validateAlert,
    overrideProblems,
    isId,
    isUTCDateTime,
    isLocalDateTime,
    isDuration,
    isSignedDuration,
    isTimeZoneId,
    isColor,
    isVendorValue,
    validPropertyName,
    CSS_COLORS
};
