// Stand-in for the @breeztech/breez-sdk-spark package main entry, used by tests
// that need require.resolve() of the SDK to succeed in an environment where the
// optional dependency is not installed. Only its location matters — the probe
// resolves better-sqlite3 relative to this file.
module.exports = {};
