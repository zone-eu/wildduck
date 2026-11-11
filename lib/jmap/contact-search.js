'use strict';

// Text matching of ContactCard/query (RFC 9610 3.3.1).
//
// A search string is split into tokens at white space; quoted text ("..." or '...', with \", \' and \\
// for literal characters) is one phrase. Every token and phrase must occur in the searched properties,
// case insensitively and on word boundaries: "and" finds "cats and dogs" but not "Sandra", and a domain
// finds an address ("example.org" in "carlos@example.org"). For text, the tokens may come from
// different properties.
//
// Matching is backed by an index: a stored card carries search terms, the lower cased words of its
// searchable properties prefixed with a field code ("e:example"). The words of a search string select
// the candidate cards through the terms index (a superset of the matches), and the candidates are then
// checked against the text itself.

const { collationKey } = require('./collation');

// field code -> what is searched: [property, object properties] or a function of the card
const FIELDS = {
    // name: full and every component; the component kinds have their own codes too
    n: card => nameValues(card),
    g: card => componentValues(card, 'given'),
    s: card => componentValues(card, 'surname'),
    s2: card => componentValues(card, 'surname2'),
    k: card => mapValues(card.nicknames, ['name']),
    o: card => mapValues(card.organizations, ['name']),
    e: card => mapValues(card.emails, ['address', 'label']),
    p: card => mapValues(card.phones, ['number', 'label']),
    l: card => mapValues(card.onlineServices, ['service', 'uri', 'user', 'label']),
    a: card => addressValues(card),
    t: card => mapValues(card.notes, ['note']),
    // searched by text only: titles, organization units, keywords and personal information
    x: card => extraValues(card)
};

// filter property -> field codes it searches
const FILTER_FIELDS = {
    text: Object.keys(FIELDS).filter(code => !['g', 's', 's2'].includes(code)),
    name: ['n'],
    'name/given': ['g'],
    'name/surname': ['s'],
    'name/surname2': ['s2'],
    nickname: ['k'],
    organization: ['o'],
    email: ['e'],
    phone: ['p'],
    onlineService: ['l'],
    address: ['a'],
    note: ['t']
};

const MAX_TERMS = 1000;
const MAX_TERM_LENGTH = 64;
const WORD = /[\p{L}\p{N}]+/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = values => values.filter(value => typeof value === 'string' && value.length);

function mapValues(map, properties) {
    if (!isObject(map)) {
        return [];
    }
    return strings(Object.values(map).flatMap(entry => (isObject(entry) ? properties.map(property => entry[property]) : [])));
}

const components = name => (isObject(name) && Array.isArray(name.components) ? name.components.filter(isObject) : []);

function componentValues(card, kind) {
    return strings(
        components(card.name)
            .filter(component => component.kind === kind)
            .map(component => component.value)
    );
}

function nameValues(card) {
    const name = card.name;
    return strings([
        isObject(name) ? name.full : null,
        ...components(name)
            .filter(component => component.kind !== 'separator')
            .map(component => component.value)
    ]);
}

function addressValues(card) {
    if (!isObject(card.addresses)) {
        return [];
    }
    return strings(
        Object.values(card.addresses)
            .filter(isObject)
            .flatMap(address => [
                address.full,
                ...components(address)
                    .filter(component => component.kind !== 'separator')
                    .map(component => component.value)
            ])
    );
}

function extraValues(card) {
    const units = isObject(card.organizations)
        ? Object.values(card.organizations)
              .filter(organization => isObject(organization) && Array.isArray(organization.units))
              .flatMap(organization => organization.units.filter(isObject).map(unit => unit.name))
        : [];
    return strings([
        ...mapValues(card.titles, ['name']),
        ...units,
        ...(isObject(card.keywords) ? Object.keys(card.keywords) : []),
        ...mapValues(card.personalInfo, ['value'])
    ]);
}

/** Lower case, white space runs as one space */
function normalize(value) {
    return value.toLowerCase().replace(/\s+/g, ' ');
}

/** The searchable text of a card, by field code, lower cased */
function searchFields(card) {
    const fields = {};
    for (const [code, values] of Object.entries(FIELDS)) {
        fields[code] = values(card).map(value => normalize(value));
    }
    return fields;
}

/** The words of a text, lower cased and cut to the term length */
const wordsOf = text => [...new Set((normalize(text).match(WORD) || []).map(word => word.slice(0, MAX_TERM_LENGTH)))];

/**
 * The search terms of a card for the terms index.
 *
 * @returns {{terms: String[], truncated: Boolean}} truncated when the card has more terms than are kept;
 *   such a card is a candidate of every search
 */
function termsOf(card) {
    const terms = new Set();
    for (const [code, values] of Object.entries(searchFields(card))) {
        for (const value of values) {
            for (const word of wordsOf(value)) {
                terms.add(`${code}:${word}`);
            }
        }
    }
    const list = [...terms];
    return { terms: list.slice(0, MAX_TERMS), truncated: list.length > MAX_TERMS };
}

/**
 * Splits a search string into tokens and phrases (RFC 9610 3.3.1). A quote without its closing quote is
 * an ordinary character.
 *
 * @returns {String[]} lower cased items, each one must be found
 */
function parseSearch(value) {
    const items = [];
    let index = 0;
    while (index < value.length) {
        while (index < value.length && /\s/.test(value[index])) {
            index++;
        }
        if (index >= value.length) {
            break;
        }
        const quote = value[index];
        if (quote === '"' || quote === "'") {
            const phrase = readPhrase(value, index + 1, quote);
            if (phrase) {
                if (phrase.text.trim()) {
                    items.push(normalize(phrase.text).trim());
                }
                index = phrase.end;
                continue;
            }
        }
        let end = index;
        while (end < value.length && !/\s/.test(value[end])) {
            end++;
        }
        items.push(normalize(value.slice(index, end)));
        index = end;
    }
    return items;
}

// the phrase starting at `start` up to the closing quote, or null when there is none
function readPhrase(value, start, quote) {
    let text = '';
    for (let index = start; index < value.length; index++) {
        const char = value[index];
        if (char === '\\' && index + 1 < value.length && ['"', "'", '\\'].includes(value[index + 1])) {
            text += value[++index];
        } else if (char === quote) {
            return { text, end: index + 1 };
        } else {
            text += char;
        }
    }
    return null;
}

/** True when `needle` occurs in `text` without splitting a word at either end */
function containsWord(text, needle) {
    if (!needle.length) {
        return true;
    }
    const startsWord = WORD_CHAR.test(needle[0]);
    const endsWord = WORD_CHAR.test(needle[needle.length - 1]);
    for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + 1)) {
        const before = index > 0 ? text[index - 1] : '';
        const after = text[index + needle.length] || '';
        if ((!startsWord || !before || !WORD_CHAR.test(before)) && (!endsWord || !after || !WORD_CHAR.test(after))) {
            return true;
        }
    }
    return false;
}

/**
 * Whether the fields of a card match a search string.
 *
 * @param {Object} fields searchFields() of the card
 * @param {String[]} codes the field codes searched
 * @param {String[]} items parseSearch() of the string
 */
function matchesSearch(fields, codes, items) {
    return items.every(item => codes.some(code => (fields[code] || []).some(text => containsWord(text, item))));
}

/**
 * A MongoDB condition on the terms field that every card matching the search satisfies.
 *
 * @returns {Object|null} null when the search has no words (nothing to narrow on)
 */
function termsCondition(codes, items) {
    const conditions = [];
    for (const word of new Set(items.flatMap(wordsOf))) {
        conditions.push(codes.length === 1 ? { terms: `${codes[0]}:${word}` } : { terms: { $in: codes.map(code => `${code}:${word}`) } });
    }
    if (!conditions.length) {
        return null;
    }
    // a card with more terms than are kept is checked against the text itself
    return { $or: [conditions.length === 1 ? conditions[0] : { $and: conditions }, { termsTruncated: true }] };
}

// ---------------------------------------------------------------- sorting

/**
 * The name sort values of a card (RFC 9610 3.3.2): the first component of each kind, or the sortAs value
 * for that kind (RFC 9553 2.2.1.1).
 */
function sortValues(card) {
    const name = card.name;
    const values = {};
    for (const kind of ['given', 'surname', 'surname2']) {
        const sortAs = isObject(name) && isObject(name.sortAs) && typeof name.sortAs[kind] === 'string' ? name.sortAs[kind] : null;
        const component = components(name).find(entry => entry.kind === kind && typeof entry.value === 'string');
        const value = sortAs !== null ? sortAs : component ? component.value : null;
        if (value !== null) {
            values[kind] = value;
        }
    }
    return values;
}

const SORT_PROPERTIES = ['created', 'updated', 'name/given', 'name/surname', 'name/surname2'];

/**
 * A comparator of query records ({id, created, updated, sort}) for a list of Comparators. Cards without
 * the value sort after all others whichever the direction; the id ends every tie.
 *
 * @returns {Function|null} null when a property or collation is not supported
 */
function compileSort(sort) {
    const comparators = [];
    for (const comparator of sort) {
        const key = collationKey(comparator.collation || undefined);
        if (!SORT_PROPERTIES.includes(comparator.property) || !key) {
            return null;
        }
        const direction = comparator.isAscending === false ? -1 : 1;
        const value = comparator.property.startsWith('name/')
            ? record => (record.sort && typeof record.sort[comparator.property.slice(5)] === 'string' ? key(record.sort[comparator.property.slice(5)]) : null)
            : record => (record[comparator.property] ? record[comparator.property].getTime() : null);
        comparators.push({ value, direction });
    }
    return (a, b) => {
        for (const { value, direction } of comparators) {
            const left = value(a);
            const right = value(b);
            if (left === right) {
                continue;
            }
            if (left === null || right === null) {
                return left === null ? 1 : -1;
            }
            return (left < right ? -1 : 1) * direction;
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };
}

module.exports = {
    FILTER_FIELDS,
    SORT_PROPERTIES,
    searchFields,
    termsOf,
    parseSearch,
    containsWord,
    matchesSearch,
    termsCondition,
    sortValues,
    compileSort,
    wordsOf
};
