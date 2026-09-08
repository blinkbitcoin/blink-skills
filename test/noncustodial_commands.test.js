/**
 * End-to-end command tests for the non-custodial (Spark) surface.
 *
 * These exercise each command's `main()` in full — argument handling, the
 * network/SDK calls it makes, the JSON it emits and the exit code it leaves —
 * rather than only the pure helpers underneath. The consolidated review flagged
 * these main flows as untested, which mattered because several of the reported
 * defects sat precisely on them.
 *
 * Nothing here touches the network or the real Breez SDK:
 *   - HTTP is stubbed through `global.fetch`.
 *   - `_spark_sdk` is replaced in the require cache with a fake `connect()`.
 *
 * Run: node --test test/noncustodial_commands.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const scriptsDir = path.resolve(__dirname, '..', 'blink', 'scripts');
const sparkSdkPath = require.resolve('../blink/scripts/_spark_sdk');

// ── shared harness ───────────────────────────────────────────────────────────

let saved = {};

beforeEach(() => {
  saved = {
    fetch: global.fetch,
    argv: process.argv,
    log: console.log,
    error: console.error,
    exit: process.exit,
    env: { ...process.env },
  };
});

afterEach(() => {
  global.fetch = saved.fetch;
  process.argv = saved.argv;
  console.log = saved.log;
  console.error = saved.error;
  process.exit = saved.exit;
  process.env = saved.env;
  process.exitCode = undefined;
  delete require.cache[sparkSdkPath];
  for (const f of [
    'create_invoice_lnaddress.js',
    'spark_balance.js',
    'spark_transactions.js',
    'spark_subscribe.js',
    'resolve_receiver.js',
  ]) {
    delete require.cache[path.join(scriptsDir, f)];
  }
  delete require.cache[require.resolve('../blink/scripts/_blink_client')];
  delete require.cache[require.resolve('../blink/scripts/_lnurl')];
});

/** Capture stdout/stderr and run a script's main() with the given argv. */
async function runScript(scriptName, argv) {
  let out = '';
  let err = '';
  console.log = (s) => {
    out += s + '\n';
  };
  console.error = (s) => {
    err += s + '\n';
  };
  process.argv = [process.execPath, scriptName, ...argv];

  // Scripts call process.exit() to short-circuit; turn that into a throwable
  // sentinel so the test can observe the code instead of killing the runner.
  const exits = [];
  process.exit = (code) => {
    exits.push(code);
    const e = new Error('__EXIT__');
    e.__exit = true;
    throw e;
  };

  const { main } = require(path.join(scriptsDir, scriptName));
  try {
    await main();
  } catch (e) {
    if (!e.__exit) throw e;
  }
  return { out, err, exits, json: () => JSON.parse(out.trim().split('\n\n')[0] || out) };
}

function stubFetch(handler) {
  global.fetch = async (url) => {
    const spec = handler(String(url)) || {};
    if (spec.throws) throw new Error(spec.throws);
    const headers = new Map();
    if (spec.location) headers.set('location', spec.location);
    return {
      ok: spec.status ? spec.status >= 200 && spec.status < 300 : true,
      status: spec.status || 200,
      headers: { get: (k) => headers.get(String(k).toLowerCase()) || null },
      async json() {
        if (spec.json === undefined) throw new Error('not json');
        return spec.json;
      },
      async text() {
        return JSON.stringify(spec.json || {});
      },
    };
  };
}

/** Replace _spark_sdk with a fake connect() returning `fakeSdk`. */
function mockSparkSdk(fakeSdk, { onDisconnect } = {}) {
  require.cache[sparkSdkPath] = {
    id: sparkSdkPath,
    filename: sparkSdkPath,
    loaded: true,
    exports: {
      async connect() {
        return {
          sdk: fakeSdk,
          disconnect: async () => {
            if (onDisconnect) onDisconnect();
          },
        };
      },
      // spark_balance imports these directly from the module.
      normalizeInfo: (info) => ({ balanceSats: Number(info && info.balanceSats) || 0 }),
      async waitForStableBalance(sdk) {
        const info = await sdk.getInfo({ ensureSynced: true });
        return { balanceSats: Number(info.balanceSats), stable: true };
      },
      normalizePayment: (p) => ({
        id: p.id || null,
        type: p.paymentType || null,
        status: p.status || null,
        amountSats: p.amount === undefined ? null : Number(p.amount),
        feeSats: p.fees === undefined ? null : Number(p.fees),
        timestamp: p.timestamp === undefined ? null : Number(p.timestamp),
      }),
    },
  };
}

/** Real BOLT-11 invoices — the binding now checks the checksum and the LUD-06
 * description-hash, so synthetic HRP-only strings no longer pass. */
const { bech32 } = require('bech32');
const crypto = require('node:crypto');

const TEST_METADATA = '[["text/plain","pay alice"]]';

function bolt11(msats, prefix = 'bc', metadata = TEST_METADATA) {
  const hrp = `ln${prefix}${msats % 100 === 0 ? msats / 100 + 'n' : msats * 10 + 'p'}`;
  const hash = crypto.createHash('sha256').update(metadata, 'utf8').digest();
  const pHash = crypto.createHash('sha256').update('payment:seed').digest();
  // Real timestamp (7 words) + p tag + h tag + 104-word signature.
  const ts = Math.floor(Date.now() / 1000);
  const tsWords = [];
  for (let w = 6; w >= 0; w--) tsWords.push(Math.floor(ts / Math.pow(32, w)) % 32);
  const words = [
    ...tsWords,
    1,
    (52 >> 5) & 31,
    52 & 31,
    ...bech32.toWords(pHash),
    23,
    (52 >> 5) & 31,
    52 & 31,
    ...bech32.toWords(hash),
    ...new Array(104).fill(0),
  ];
  return bech32.encode(hrp, words, 20000);
}

// ── create-invoice-lnaddress ─────────────────────────────────────────────────

describe('create_invoice_lnaddress main()', () => {
  const PR = bolt11(1000 * 1000); // 1000 sats

  function happyPath({ pr = PR, verify = 'https://blink.sv/verify/abc', custodial = false } = {}) {
    stubFetch((url) => {
      if (url.includes('/graphql')) {
        return custodial
          ? { json: { data: { accountDefaultWallet: { id: 'wallet-1', walletCurrency: 'BTC' } } } }
          : { json: { errors: [{ message: 'Account does not exist for username' }] } };
      }
      if (url.includes('/.well-known/lnurlp/')) {
        return {
          json: {
            tag: 'payRequest',
            metadata: TEST_METADATA,
            callback: 'https://blink.sv/cb',
            minSendable: 1000,
            maxSendable: 1e9,
            commentAllowed: 100,
          },
        };
      }
      return { json: { pr, verify } };
    });
  }

  it('mints an invoice for a non-custodial recipient with --no-verify', async () => {
    happyPath();
    const r = await runScript('create_invoice_lnaddress.js', ['alice@blink.sv', '1000', '--no-verify']);
    const j = r.json();
    assert.equal(j.event, 'invoice_created');
    assert.equal(j.accountType, 'lnaddress');
    assert.equal(j.lightningAddress, 'alice@blink.sv');
    assert.equal(j.paymentRequest, PR);
    assert.equal(j.verifyUrl, 'https://blink.sv/verify/abc');
    assert.equal(j.satoshis, 1000);
    assert.equal(j.walletId, null);
  });

  it('reports a custodial recipient with its wallet id', async () => {
    happyPath({ custodial: true });
    const r = await runScript('create_invoice_lnaddress.js', ['bob@blink.sv', '1000', '--no-verify']);
    const j = r.json();
    assert.equal(j.accountType, 'custodial');
    assert.equal(j.walletId, 'wallet-1');
  });

  it('passes a memo through as an LNURL comment', async () => {
    let commentSeen = null;
    stubFetch((url) => {
      if (url.includes('/graphql')) return { json: { errors: [{ message: 'Account does not exist for username' }] } };
      if (url.includes('/.well-known/lnurlp/')) {
        return {
          json: {
            tag: 'payRequest',
            metadata: TEST_METADATA,
            callback: 'https://blink.sv/cb',
            minSendable: 1000,
            maxSendable: 1e9,
            commentAllowed: 50,
          },
        };
      }
      commentSeen = new URL(url).searchParams.get('comment');
      return { json: { pr: PR, verify: null } };
    });
    await runScript('create_invoice_lnaddress.js', ['alice@blink.sv', '1000', 'coffee', 'money', '--no-verify']);
    assert.equal(commentSeen, 'coffee money');
  });

  it('refuses a non-Blink domain without making any request', async () => {
    let called = false;
    global.fetch = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await assert.rejects(
      () => runScript('create_invoice_lnaddress.js', ['alice@attacker.example', '1000', '--no-verify']),
      /non-Blink domain/,
    );
    assert.equal(called, false);
  });

  it('refuses an invoice whose amount does not match the request', async () => {
    happyPath({ pr: bolt11(1) }); // server returns 1 msat for a 1000 sat ask
    await assert.rejects(
      () => runScript('create_invoice_lnaddress.js', ['alice@blink.sv', '1000', '--no-verify']),
      /Refusing it/,
    );
  });

  it('refuses a callback pointing off the allowlist', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) return { json: { errors: [{ message: 'Account does not exist for username' }] } };
      if (url.includes('/.well-known/lnurlp/')) {
        return {
          json: {
            tag: 'payRequest',
            metadata: TEST_METADATA,
            callback: 'https://attacker.example/cb',
            minSendable: 1,
            maxSendable: 1e9,
          },
        };
      }
      return { json: { pr: PR } };
    });
    await assert.rejects(
      () => runScript('create_invoice_lnaddress.js', ['alice@blink.sv', '1000', '--no-verify']),
      /non-Blink host/,
    );
  });

  it('reports PAID and exits 0 when verify settles for our invoice', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) return { json: { errors: [{ message: 'Account does not exist' }] } };
      if (url.includes('/.well-known/lnurlp/')) {
        return {
          json: {
            tag: 'payRequest',
            metadata: TEST_METADATA,
            callback: 'https://blink.sv/cb',
            minSendable: 1000,
            maxSendable: 1e9,
          },
        };
      }
      if (url.includes('/verify/')) {
        return { json: { status: 'OK', settled: true, preimage: 'deadbeef', pr: PR } };
      }
      return { json: { pr: PR, verify: 'https://blink.sv/verify/abc' } };
    });
    const r = await runScript('create_invoice_lnaddress.js', ['alice@blink.sv', '1000', '--timeout', '5']);
    const docs = r.out.trim().split(/\n(?=\{)/);
    const verifyDoc = JSON.parse(docs[docs.length - 1]);
    assert.equal(verifyDoc.event, 'verify_result');
    assert.equal(verifyDoc.status, 'PAID');
    assert.equal(verifyDoc.preimage, 'deadbeef');
    assert.deepEqual(r.exits, [0]);
  });

  it('reports TIMEOUT and exits 1 when settlement never arrives', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) return { json: { errors: [{ message: 'Account does not exist' }] } };
      if (url.includes('/.well-known/lnurlp/')) {
        return {
          json: {
            tag: 'payRequest',
            metadata: TEST_METADATA,
            callback: 'https://blink.sv/cb',
            minSendable: 1000,
            maxSendable: 1e9,
          },
        };
      }
      if (url.includes('/verify/')) return { json: { status: 'OK', settled: false } };
      return { json: { pr: PR, verify: 'https://blink.sv/verify/abc' } };
    });
    // 1s: pollVerify checks the deadline after its first read, so this settles
    // into TIMEOUT on the second pass (~3s) rather than looping.
    const r = await runScript('create_invoice_lnaddress.js', ['alice@blink.sv', '1000', '--timeout', '1']);
    const docs = r.out.trim().split(/\n(?=\{)/);
    assert.equal(JSON.parse(docs[docs.length - 1]).status, 'TIMEOUT');
    assert.deepEqual(r.exits, [1]);
  });

  // A settlement claimed for someone else's invoice is a policy failure, not a
  // transient one: retrying can only hide it, and with --timeout 0 forever.
  it('aborts rather than looping when verify settles a DIFFERENT invoice', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) return { json: { errors: [{ message: 'Account does not exist' }] } };
      if (url.includes('/.well-known/lnurlp/')) {
        return {
          json: {
            tag: 'payRequest',
            metadata: TEST_METADATA,
            callback: 'https://blink.sv/cb',
            minSendable: 1000,
            maxSendable: 1e9,
          },
        };
      }
      if (url.includes('/verify/')) {
        return { json: { status: 'OK', settled: true, pr: bolt11(9999 * 1000) } };
      }
      return { json: { pr: PR, verify: 'https://blink.sv/verify/abc' } };
    });
    await assert.rejects(
      () => runScript('create_invoice_lnaddress.js', ['alice@blink.sv', '1000', '--timeout', '0']),
      /DIFFERENT invoice/,
    );
  });

  it('surfaces a bad amount argument', async () => {
    await assert.rejects(
      () => runScript('create_invoice_lnaddress.js', ['alice@blink.sv', '-5', '--no-verify']),
      /positive integer/,
    );
  });

  it('propagates a custodial-probe outage instead of guessing', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) return { status: 503, json: {} };
      return {
        json: {
          tag: 'payRequest',
          metadata: TEST_METADATA,
          callback: 'https://blink.sv/cb',
          minSendable: 1,
          maxSendable: 1e9,
        },
      };
    });
    await assert.rejects(
      () => runScript('create_invoice_lnaddress.js', ['alice@blink.sv', '1000', '--no-verify']),
      (e) => e.code === 'CUSTODIAL_PROBE_FAILED',
    );
  });
});

// ── resolve-receiver ─────────────────────────────────────────────────────────

describe('resolve_receiver main()', () => {
  it('emits a custodial classification', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) {
        return { json: { data: { accountDefaultWallet: { id: 'w-9', walletCurrency: 'BTC' } } } };
      }
      return { status: 404, json: {} };
    });
    const r = await runScript('resolve_receiver.js', ['bob@blink.sv']);
    const j = r.json();
    assert.equal(j.type, 'custodial');
    assert.equal(j.walletId, 'w-9');
  });

  it('emits a non-custodial classification', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) return { json: { data: { accountDefaultWallet: null } } };
      return {
        json: {
          tag: 'payRequest',
          metadata: TEST_METADATA,
          callback: 'https://blink.sv/cb',
          minSendable: 1,
          maxSendable: 1e9,
        },
      };
    });
    const r = await runScript('resolve_receiver.js', ['alice@blink.sv']);
    assert.equal(r.json().type, 'lnaddress');
  });
});

// ── spark-balance ────────────────────────────────────────────────────────────

describe('spark_balance main()', () => {
  it('emits the balance and disconnects', async () => {
    let disconnected = false;
    mockSparkSdk(
      {
        async getInfo() {
          return { balanceSats: 2551n };
        },
      },
      { onDisconnect: () => (disconnected = true) },
    );
    const r = await runScript('spark_balance.js', []);
    const j = r.json();
    assert.equal(j.balanceSats, 2551);
    assert.equal(j.stable, true);
    assert.equal(j.accountType, 'lnaddress');
    assert.equal(disconnected, true, 'must always disconnect');
  });

  it('still disconnects when the SDK throws', async () => {
    let disconnected = false;
    mockSparkSdk(
      {
        async getInfo() {
          throw new Error('sync failed');
        },
      },
      { onDisconnect: () => (disconnected = true) },
    );
    await assert.rejects(() => runScript('spark_balance.js', []), /sync failed/);
    assert.equal(disconnected, true);
  });
});

// ── spark-transactions ───────────────────────────────────────────────────────

describe('spark_transactions main()', () => {
  const payments = [
    { id: 'p1', paymentType: 'send', status: 'completed', amount: 10n, fees: 3n, timestamp: 1710000000 },
    { id: 'p2', paymentType: 'receive', status: 'completed', amount: 500n, fees: 0n, timestamp: 1710000100 },
  ];

  it('lists and normalizes payments', async () => {
    mockSparkSdk({
      async listPayments() {
        return payments;
      },
    });
    const r = await runScript('spark_transactions.js', []);
    const j = r.json();
    assert.equal(j.count, 2);
    assert.equal(j.transactions[0].amountSats, 10);
    assert.equal(j.transactions[0].feeSats, 3);
    assert.equal(j.transactions[1].type, 'receive');
  });

  it('accepts the { payments } envelope shape too', async () => {
    mockSparkSdk({
      async listPayments() {
        return { payments };
      },
    });
    const r = await runScript('spark_transactions.js', []);
    assert.equal(r.json().count, 2);
  });

  it('forwards --limit to the SDK', async () => {
    let seen = null;
    mockSparkSdk({
      async listPayments(req) {
        seen = req;
        return [];
      },
    });
    await runScript('spark_transactions.js', ['--limit', '50']);
    assert.equal(seen.limit, 50);
  });

  it('rejects a non-positive --limit', async () => {
    mockSparkSdk({
      async listPayments() {
        return [];
      },
    });
    await assert.rejects(() => runScript('spark_transactions.js', ['--limit', '0']), /positive integer/);
  });

  it('reports an empty history as count 0, not an error', async () => {
    mockSparkSdk({
      async listPayments() {
        return [];
      },
    });
    const r = await runScript('spark_transactions.js', []);
    assert.equal(r.json().count, 0);
  });
});

// ── spark-subscribe ──────────────────────────────────────────────────────────

describe('spark_subscribe main()', () => {
  it('registers a listener, emits events, then cleans up on timeout', async () => {
    let removed = null;
    let disconnected = false;
    let listener = null;
    mockSparkSdk(
      {
        async addEventListener(l) {
          listener = l;
          // Deliver an event as soon as the listener is registered.
          setImmediate(() => l.onEvent({ type: 'synced' }));
          return 'listener-7';
        },
        async removeEventListener(id) {
          removed = id;
        },
      },
      { onDisconnect: () => (disconnected = true) },
    );

    // timeout is in seconds; 0 would run forever, so use the smallest value
    // that still exercises the timeout branch.
    const r = await runScript('spark_subscribe.js', ['--timeout', '1']);

    assert.ok(listener, 'a listener must be registered');
    assert.match(r.out, /"event":\s*"sdk_event"/);
    assert.match(r.out, /synced/);
    assert.equal(removed, 'listener-7', 'must remove the listener it added');
    assert.equal(disconnected, true);
    assert.deepEqual(r.exits, [0]);
  });

  it('rejects a negative --timeout', async () => {
    mockSparkSdk({
      async addEventListener() {
        return 1;
      },
    });
    await assert.rejects(() => runScript('spark_subscribe.js', ['--timeout', '-1']), /non-negative/);
  });
});
