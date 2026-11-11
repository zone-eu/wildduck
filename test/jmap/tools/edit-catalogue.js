'use strict';

// Edits scenario fields in the JMAP catalogue in place, keeping the layout of the YAML files
// (a YAML dumper would reformat every file). Validates the catalogue afterwards.
//
// Usage: node test/jmap/tools/edit-catalogue.js edits.json
// edits.json: [{"id": "EGET-001", "set": {"then": "...", "phase": 4}, "unset": ["planned"]}]
// Strings are written as double quoted scalars, numbers and booleans as plain scalars.
// Every scenario field sits on one line in the catalogue, which this tool relies on.

const fs = require('fs');
const path = require('path');
const { loadCatalogue, FIELD_ORDER, BANNED_CHARS, CATALOGUE_DIR } = require('./catalogue');

const BLOCK_START = /^ {2}- id: (\S+)\s*$/;
const FIELD_LINE = /^ {4}([a-z]+):/;

function scalar(value) {
    if (typeof value === 'boolean' || Number.isInteger(value)) {
        return String(value);
    }
    if (typeof value !== 'string' || BANNED_CHARS.test(value)) {
        throw new Error(`invalid value ${JSON.stringify(value)}`);
    }
    return JSON.stringify(value);
}

// One pass over a file: scenario id -> [first line, end line) of its block, without trailing blank lines
function indexBlocks(lines) {
    const blocks = new Map();
    let current = null;
    const close = end => {
        while (current && end > current.start + 1 && !lines[end - 1].trim()) {
            end--;
        }
        if (current) {
            current.end = end;
        }
    };
    lines.forEach((line, i) => {
        const match = BLOCK_START.exec(line);
        if (match || /^\S/.test(line)) {
            close(i);
            current = match ? { start: i, end: lines.length } : null;
            if (match) {
                blocks.set(match[1], current);
            }
        }
    });
    close(lines.length);
    return blocks;
}

// Field name -> line index inside a block. Continuation lines (list items) belong to the field above.
function fieldLines(lines, block) {
    const fields = new Map();
    for (let i = block.start + 1; i < block.end; i++) {
        const match = FIELD_LINE.exec(lines[i]);
        if (match) {
            let end = i + 1;
            while (end < block.end && /^ {6}/.test(lines[end])) {
                end++;
            }
            fields.set(match[1], { start: i, end });
        }
    }
    return fields;
}

function applyEdit(lines, block, edit) {
    for (const name of edit.unset || []) {
        const span = fieldLines(lines, block).get(name);
        if (span) {
            lines.splice(span.start, span.end - span.start);
            block.end -= span.end - span.start;
        }
    }
    for (const [name, value] of Object.entries(edit.set || {})) {
        if (!FIELD_ORDER.includes(name) || name === 'id') {
            throw new Error(`${edit.id}: field ${name} cannot be set`);
        }
        const line = `    ${name}: ${scalar(value)}`;
        const fields = fieldLines(lines, block);
        const span = fields.get(name);
        if (span) {
            lines.splice(span.start, span.end - span.start, line);
            block.end -= span.end - span.start - 1;
            continue;
        }
        const later = FIELD_ORDER.slice(FIELD_ORDER.indexOf(name) + 1).find(other => fields.has(other));
        const at = later ? fields.get(later).start : block.end;
        lines.splice(at, 0, line);
        block.end++;
    }
}

function main() {
    const edits = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
    const pending = new Map(edits.map(edit => [edit.id, edit]));

    for (const name of fs.readdirSync(CATALOGUE_DIR).filter(file => file.endsWith('.yaml'))) {
        const filePath = path.join(CATALOGUE_DIR, name);
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        const blocks = indexBlocks(lines);
        const ids = [...pending.keys()].filter(id => blocks.has(id));
        // Edit from the bottom up so earlier block positions stay valid
        ids.sort((a, b) => blocks.get(b).start - blocks.get(a).start);
        ids.forEach(id => {
            applyEdit(lines, blocks.get(id), pending.get(id));
            pending.delete(id);
        });
        if (ids.length) {
            fs.writeFileSync(filePath, lines.join('\n'));
        }
    }

    if (pending.size) {
        throw new Error(`not found: ${[...pending.keys()].join(', ')}`);
    }
    const { errors } = loadCatalogue();
    if (errors.length) {
        errors.forEach(error => console.error(`ERROR ${error}`));
        process.exit(1);
    }
    console.log(`applied ${edits.length} edits, catalogue valid`);
}

main();
