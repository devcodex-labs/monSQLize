'use strict';

const { createHash } = require('node:crypto');

function engineBuildHash(manifest) {
    // The hash identifies the engine inputs; binary digests are target-specific.
    const inputs = [manifest.sha256['sqlite3.c'], manifest.patch, manifest.sqliteDefines];
    return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

module.exports = engineBuildHash;
