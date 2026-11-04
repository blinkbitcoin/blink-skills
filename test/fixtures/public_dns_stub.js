'use strict';

/**
 * In-process test seam for the resolved-address guard (_lnurl.js): every name
 * resolves to a PUBLIC documentation address, so the suites never query real
 * DNS and stay deterministic offline. Tests that exercise the guard install
 * their own resolver under the same key and restore this one afterwards.
 *
 * Usage: require('./fixtures/public_dns_stub') at the top of a test file.
 */
const KEY = Symbol.for('blink-skills.test.hostResolver');

globalThis[KEY] = async () => [{ address: '93.184.215.14', family: 4 }];

module.exports = { KEY };
