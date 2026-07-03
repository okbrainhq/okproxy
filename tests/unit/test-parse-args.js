// Unit tests for parseArgs functionality

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseArgs } = require('../../apps/server/index.js');

describe('parseArgs defaults', () => {
  it('should default stream timeout to 5 minutes', () => {
    const opts = parseArgs([]);
    assert.strictEqual(opts.streamTimeout, 300000);
  });
});

describe('parseArgs --max-body-size', () => {
  it('should default maxBodySize to undefined', () => {
    const opts = parseArgs([]);
    assert.strictEqual(opts.maxBodySize, undefined);
  });

  it('should parse a valid --max-body-size value', () => {
    const opts = parseArgs(['--max-body-size', '230686720']);
    assert.strictEqual(opts.maxBodySize, 230686720);
  });

  it('should reject zero', () => {
    // parseArgs calls process.exit(1) on invalid input; test via try/catch
    // but since process.exit won't be called by default in a test, 
    // we verify the behavior by checking that invalid input is guarded
    const exitSpy = { called: false };
    const origExit = process.exit;
    process.exit = (code) => { exitSpy.called = true; exitSpy.code = code; throw new Error('exit'); };
    try {
      try {
        parseArgs(['--max-body-size', '0']);
      } catch (e) {
        // expected - process.exit throws
      }
      assert.ok(exitSpy.called, 'Should call process.exit for 0');
      assert.strictEqual(exitSpy.code, 1);
    } finally {
      process.exit = origExit;
    }
  });

  it('should reject NaN / non-numeric values', () => {
    const exitSpy = { called: false };
    const origExit = process.exit;
    process.exit = (code) => { exitSpy.called = true; exitSpy.code = code; throw new Error('exit'); };
    try {
      try {
        parseArgs(['--max-body-size', 'abc']);
      } catch (e) {
        // expected
      }
      assert.ok(exitSpy.called, 'Should call process.exit for non-numeric');
      assert.strictEqual(exitSpy.code, 1);
    } finally {
      process.exit = origExit;
    }
  });

  it('should reject negative numbers', () => {
    const exitSpy = { called: false };
    const origExit = process.exit;
    process.exit = (code) => { exitSpy.called = true; exitSpy.code = code; throw new Error('exit'); };
    try {
      try {
        parseArgs(['--max-body-size', '-1']);
      } catch (e) {
        // expected
      }
      assert.ok(exitSpy.called, 'Should call process.exit for negative');
      assert.strictEqual(exitSpy.code, 1);
    } finally {
      process.exit = origExit;
    }
  });

  it('should reject floats', () => {
    const exitSpy = { called: false };
    const origExit = process.exit;
    process.exit = (code) => { exitSpy.called = true; exitSpy.code = code; throw new Error('exit'); };
    try {
      try {
        parseArgs(['--max-body-size', '1024.5']);
      } catch (e) {
        // expected
      }
      assert.ok(exitSpy.called, 'Should call process.exit for float');
      assert.strictEqual(exitSpy.code, 1);
    } finally {
      process.exit = origExit;
    }
  });

  it('should reject trailing garbage', () => {
    const exitSpy = { called: false };
    const origExit = process.exit;
    process.exit = (code) => { exitSpy.called = true; exitSpy.code = code; throw new Error('exit'); };
    try {
      try {
        parseArgs(['--max-body-size', '123abc']);
      } catch (e) {
        // expected
      }
      assert.ok(exitSpy.called, 'Should call process.exit for trailing garbage');
      assert.strictEqual(exitSpy.code, 1);
    } finally {
      process.exit = origExit;
    }
  });

  it('should accept large values like 220MB', () => {
    const opts = parseArgs(['--max-body-size', String(220 * 1024 * 1024)]);
    assert.strictEqual(opts.maxBodySize, 220 * 1024 * 1024);
  });

  it('should reject unsafe integers', () => {
    const exitSpy = { called: false };
    const origExit = process.exit;
    process.exit = (code) => { exitSpy.called = true; exitSpy.code = code; throw new Error('exit'); };
    try {
      try {
        parseArgs(['--max-body-size', String(Number.MAX_SAFE_INTEGER + 1)]);
      } catch (e) {
        // expected
      }
      // Number.MAX_SAFE_INTEGER + 1 cannot be represented exactly, so parseInt may give a different value
      // but the check uses Number.isSafeInteger which should catch it
      assert.ok(exitSpy.called, 'Should reject unsafe integers');
    } finally {
      process.exit = origExit;
    }
  });
});
