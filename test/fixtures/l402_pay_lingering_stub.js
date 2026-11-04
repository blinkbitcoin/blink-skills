'use strict';

/**
 * --require fixture: replaces l402_pay with a stub that behaves like a
 * Spark-backed post-payment failure in v3.0.2+ — it prints its JSON result,
 * sets process.exitCode = 1 and RETURNS, while an event-loop handle stays open
 * (as the Breez SDK leaves them). A caller that does not drain-then-exit would
 * hang forever on that handle.
 */
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (/(^|[\\/])l402_pay(\.js)?$/.test(request)) {
    return {
      main: async () => {
        setInterval(() => {}, 60_000); // the lingering SDK handle
        console.log(JSON.stringify({ event: 'l402_paid_retry_failed', backend: 'spark', tokenStored: true }, null, 2));
        process.exitCode = 1;
      },
    };
  }
  return originalLoad.apply(this, [request, parent, isMain]);
};
