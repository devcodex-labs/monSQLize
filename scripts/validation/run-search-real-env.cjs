#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BSON } = require('mongodb');
const { runSearchSuite, errorInfo } = require('./search-real-env-suite.cjs');

function readConfig(env) {
    const out = env.MONSQLIZE_SEARCH_REAL_OUT;
    if (out !== undefined && !out.trim()) throw new Error('MONSQLIZE_SEARCH_REAL_OUT must be a non-empty output path');
    const rawTimeout = env.MONSQLIZE_SEARCH_REAL_TIMEOUT_MS;
    const timeoutMs = rawTimeout === undefined ? 600000 : Number(rawTimeout);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || (rawTimeout !== undefined && !rawTimeout.trim())) {
        throw new Error('MONSQLIZE_SEARCH_REAL_TIMEOUT_MS must be a positive safe integer in milliseconds');
    }
    return { uri: env.MONSQLIZE_VECTOR_SEARCH_URI?.trim() || env.MONSQLIZE_ATLAS_LOCAL_URI?.trim() || '', out, timeoutMs };
}

function reportJson(report, uris = []) {
    const secrets = [];
    const passwords = new Set();
    for (const uri of uris.filter(Boolean)) {
        secrets.push(uri);
        const auth = uri.match(/^mongodb(?:\+srv)?:\/\/([^/?#]*?)@/i)?.[1];
        if (auth) {
            secrets.push(auth);
            const password = auth.slice(auth.indexOf(':') + 1);
            if (auth.includes(':') && password) {
                passwords.add(password);
                try { passwords.add(decodeURIComponent(password)); } catch { /* Retain the encoded credential. */ }
            }
        }
    }
    secrets.sort((a, b) => b.length - a.length);
    const tokens = [...passwords].sort((a, b) => b.length - a.length).map(password => password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const passwordPattern = tokens.length ? new RegExp('(?<![\\p{L}\\p{N}_])(?:' + tokens.join('|') + ')(?![\\p{L}\\p{N}_])', 'gu') : undefined;
    const plain = BSON.EJSON.serialize(report, { relaxed: true });
    return JSON.stringify(plain, function (key, value) {
        // The protocol status is not credential data, even for a password "passed".
        if (this === plain && key === 'status') return value;
        if (typeof value !== 'string') return value;
        for (const secret of secrets) value = value.split(secret).join('<redacted>');
        return passwordPattern ? value.split(/(<redacted>)/).map(segment =>
            segment === '<redacted>' ? segment : segment.replace(passwordPattern, '<redacted>')).join('') : value;
    }, 2);
}

async function main(env = process.env, dependencies = {}) {
    const write = dependencies.write || ((value) => process.stdout.write(value + '\n'));
    const uris = [env.MONSQLIZE_VECTOR_SEARCH_URI?.trim(), env.MONSQLIZE_ATLAS_LOCAL_URI?.trim()];
    let config;
    let report;
    try {
        config = readConfig(env);
        report = config.uri ? await (dependencies.run || runSearchSuite)(config) : {
            status: 'skipped', reason: 'SKIPPED: set MONSQLIZE_VECTOR_SEARCH_URI or MONSQLIZE_ATLAS_LOCAL_URI to an authorized disposable Search deployment.',
        };
    } catch (error) { report = { status: 'failed', errors: [{ operation: config ? 'suite' : 'config', ...errorInfo(error) }] }; }
    if (config?.out) {
        try {
            fs.mkdirSync(path.dirname(path.resolve(config.out)), { recursive: true });
            fs.writeFileSync(config.out, reportJson(report, uris) + '\n');
        } catch (error) {
            report.status = 'failed';
            (report.errors ||= []).push({ operation: 'write-report', ...errorInfo(error) });
        }
    }
    try { write(reportJson(report, uris)); }
    catch (error) {
        process.stderr.write(reportJson({ status: 'failed', errors: [{ operation: 'serialize-report', ...errorInfo(error) }] }, uris) + '\n');
        return 1;
    }
    return report.status === 'failed' ? 1 : 0;
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
module.exports = { readConfig, reportJson, main };
