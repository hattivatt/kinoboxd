'use strict';

/**
 * `server/core/jobs.js`: the single job registry behind all nine `start*` /
 * `getStatus` pairs. Covers the mechanics the domains rely on: single-flight
 * coalescing (including alias keys), stage/progress snapshots, the serialized
 * chain, the failure snapshot, the cooldown window (with an injected clock)
 * and retention.
 *
 * No timers and no sleeps: every scenario resolves through promises, and the
 * cooldown clock is a variable, so the file stays deterministic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createJobs } = require('../server/core/jobs');

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('single-flight: a second start for the same key joins the live job', async () => {
  const jobs = createJobs({ name: 'test', keyOf: (job) => job.key });
  const gate = deferred();
  let runs = 0;

  const first = jobs.start('alpha', async (job) => {
    runs++;
    await gate.promise;
    job.stage = 'done';
  });
  const second = jobs.start('alpha', async () => {
    runs++;
  });

  assert.equal(second, first, 'the second start returns the live job');
  await tick();
  assert.equal(runs, 1, 'the task body ran once');
  assert.equal(jobs.isRunning('alpha'), true);

  gate.resolve();
  await jobs.whenIdle();

  assert.equal(runs, 1);
  assert.equal(jobs.isRunning('alpha'), false);
  assert.equal(jobs.get(first.id).status, 'done');
  assert.equal(jobs.get(first.id).done, true);
});

test('a finished key can start again; alias keys coalesce too', async () => {
  const jobs = createJobs({ name: 'test', keyOf: (job) => job.key });

  const first = jobs.start('vanity:bob', async (job) => {
    job.stage = 'done';
  }, { fields: { key: 'vanity:bob', aliasKeys: ['steam-42'] } });
  assert.equal(jobs.isRunning('steam-42'), true, 'the alias is live while running');

  const joined = jobs.start('steam-42', async () => {});
  assert.equal(joined, first);

  await jobs.whenIdle();
  assert.equal(jobs.isRunning('steam-42'), false, 'a finished job is not live');

  const next = jobs.start('steam-42', async () => {});
  assert.notEqual(next.id, first.id, 'a new job is created after the first one finished');
  await jobs.whenIdle();
});

test('a task may move its own key and keep the old one as an alias', async () => {
  const jobs = createJobs({ name: 'test', keyOf: (job) => job.key });
  const gate = deferred();

  const job = jobs.start('vanity:bob', async (self) => {
    self.aliasKeys = [...(self.aliasKeys || []), self.key];
    self.key = 'steam-42';
    await gate.promise;
  });

  await tick();
  assert.equal(jobs.isRunning('steam-42'), true);
  assert.equal(jobs.isRunning('vanity:bob'), true);
  assert.equal(jobs.start('steam-42', async () => {}), job, 'no second job for the owner key');

  gate.resolve();
  await jobs.whenIdle();
});

test('stages and progress land in the unified snapshot', async () => {
  const jobs = createJobs({ name: 'test', keyOf: (job) => job.key });
  let seen = null;

  const job = jobs.start('p', async (self) => {
    self.setStage('library', 3, 10);
    seen = jobs.snapshot(jobs.get(self.id));
    self.setProgress(10, 10);
    self.stage = 'done';
  });

  await jobs.whenIdle();
  assert.equal(seen.stage, 'library');
  assert.deepEqual(seen.progress, { current: 3, total: 10 });
  assert.equal(seen.status, 'running');
  assert.equal(seen.error, null);
  assert.equal(seen.partial, null);
  assert.equal(typeof seen.startedAt, 'number');

  const done = jobs.snapshot(job);
  assert.equal(done.stage, 'done');
  assert.deepEqual(done.progress, { current: 10, total: 10 });
  assert.equal(done.status, 'done');
  assert.equal(typeof done.finishedAt, 'number');
});

test('a task that throws leaves an honest error snapshot and a finished job', async () => {
  const jobs = createJobs({ name: 'demo', keyOf: (job) => job.key });

  const job = jobs.start('broken', async (self) => {
    self.setStage('fetching', 1, 4);
    const err = new Error('boom');
    err.code = 'demo_boom';
    err.retryAt = 123;
    throw err;
  });

  await jobs.whenIdle();
  const status = jobs.status(job.id);
  assert.equal(status.status, 'failed');
  assert.equal(status.stage, 'failed');
  assert.equal(status.error, 'boom');
  assert.equal(job.code, 'demo_boom', 'the error code is preserved');
  assert.equal(job.retryAt, 123, 'retryAt is preserved');
  assert.equal(job.done, true);
  assert.equal(typeof status.finishedAt, 'number');
  assert.equal(jobs.isRunning('broken'), false);
});

test('a deferred error keeps its own status, like the Epic import', async () => {
  const jobs = createJobs({ name: 'epic', keyOf: (job) => job.key });
  const job = jobs.start('deferred', async () => {
    const err = new Error('network');
    err.code = 'epic_unreachable';
    err.deferred = true;
    throw err;
  });

  await jobs.whenIdle();
  assert.equal(job.status, 'deferred');
  assert.equal(job.stage, 'deferred');
  assert.equal(job.done, true);
  assert.equal(jobs.status(job.id).status, 'deferred');
});

test('a domain verdict (skipped) survives the finalizer', async () => {
  const jobs = createJobs({ name: 'test', keyOf: (job) => job.key });
  const job = jobs.start('skipped', async (self) => {
    self.status = 'skipped';
    self.stage = 'skipped';
    self.skipped = 'lock_busy';
  });

  await jobs.whenIdle();
  assert.equal(job.status, 'skipped');
  assert.equal(job.done, true);
  assert.equal(job.percent, 0, 'a skipped job is not 100 % done');
  assert.equal(job.skipped, 'lock_busy');
});

test('cooldown window: the last pass throttles a re-kick until it expires', async () => {
  let clock = 1000;
  const jobs = createJobs({
    name: 'test',
    keyOf: (job) => job.key,
    cooldownMs: 60_000,
    now: () => clock,
  });

  assert.equal(jobs.cooldownRemaining('p'), 0, 'nothing ran yet');

  jobs.start('p', async (job) => {
    job.status = 'done';
    job.stage = 'done';
  });
  await jobs.whenIdle();

  clock += 10_000;
  assert.equal(jobs.cooldownRemaining('p'), 50_000);
  assert.deepEqual(jobs.lastFinish('p'), { at: 1000, status: 'done', skipped: null });

  clock += 50_000;
  assert.equal(jobs.cooldownRemaining('p'), 0, 'the window expired');

  jobs.resetCooldown();
  assert.equal(jobs.lastFinish('p'), null);
});

test('a failed pass is not throttled; a custom ignore rule can widen that', async () => {
  let clock = 5000;
  const jobs = createJobs({
    name: 'test',
    keyOf: (job) => job.key,
    cooldownMs: 10_000,
    now: () => clock,
  });

  jobs.start('f', async (job) => {
    job.status = 'failed';
    job.stage = 'failed';
  });
  await jobs.whenIdle();
  assert.equal(jobs.cooldownRemaining('f'), 0, 'failure never opens the window');

  jobs.start('s', async (job) => {
    job.status = 'skipped';
    job.stage = 'skipped';
    job.skipped = 'lock_busy';
  });
  await jobs.whenIdle();
  clock += 1000;
  assert.equal(jobs.cooldownRemaining('s'), 9000, 'a skip throttles by default');
  assert.equal(
    jobs.cooldownRemaining('s', { ignore: (record) => record.skipped === 'lock_busy' }),
    0,
    'the franchise rule ignores a busy lock'
  );
});

test('two independent keys are accepted and both complete', async () => {
  const jobs = createJobs({ name: 'test', keyOf: (job) => job.key });
  const first = jobs.start('a', async (job) => {
    job.stage = 'done';
  });
  const second = jobs.start('b', async (job) => {
    job.stage = 'done';
  });

  assert.notEqual(first.id, second.id);
  await jobs.whenIdle();
  assert.equal(first.done, true);
  assert.equal(second.done, true);
});

test('per-key chains let two keys overlap; the default chain serializes', async () => {
  const jobs = createJobs({ name: 'test', keyOf: (job) => job.key });
  const gate = deferred();
  let parallel = false;
  let running = 0;

  const first = jobs.start('a', async () => {
    running++;
    await gate.promise;
    running--;
  }, { chainKey: 'a' });
  const second = jobs.start('b', async () => {
    running++;
    parallel = running > 1;
    running--;
  }, { chainKey: 'b' });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(parallel, true, 'different chain keys run concurrently');
  gate.resolve();
  await jobs.whenIdle();
  assert.equal(first.done, true);
  assert.equal(second.done, true);

  const serial = createJobs({ name: 'test', keyOf: (job) => job.key });
  let serialParallel = false;
  let live = 0;
  const block = deferred();
  serial.start('a', async () => {
    live++;
    await block.promise;
    live--;
  });
  serial.start('b', async () => {
    live++;
    serialParallel = live > 1;
    live--;
  });
  block.resolve();
  await serial.whenIdle();
  assert.equal(serialParallel, false, 'the registry-wide chain is serial');
});

test('retention keeps the newest maxJobs and forgets the oldest', async () => {
  const jobs = createJobs({ name: 'test', keyOf: (job) => job.key, maxJobs: 2 });
  const first = jobs.start('a', async () => {});
  await jobs.whenIdle();
  const second = jobs.start('b', async () => {});
  await jobs.whenIdle();
  const third = jobs.start('c', async () => {});
  await jobs.whenIdle();

  assert.equal(jobs.get(first.id), undefined);
  assert.ok(jobs.get(second.id));
  assert.ok(jobs.get(third.id));
  assert.equal(jobs.list().length, 2);
});

test('job.finish() and job.fail() finalize from inside the task', async () => {
  const jobs = createJobs({ name: 'test', keyOf: (job) => job.key, errorCode: 'test_manual' });
  const ok = jobs.start('ok', async (job) => {
    job.finish({ gameCount: 3 });
  });
  await jobs.whenIdle();
  assert.equal(ok.status, 'done');
  assert.equal(ok.done, true);
  assert.equal(ok.percent, 100);
  assert.equal(ok.gameCount, 3);

  const bad = jobs.start('bad', async (job) => {
    job.fail(new Error('nope'));
  });
  await jobs.whenIdle();
  assert.equal(bad.status, 'failed');
  assert.equal(bad.code, 'test_manual');
  assert.equal(bad.error, 'nope');
  assert.equal(bad.done, true);
});

test('onFinish can replace the default finalizer (books import shape)', async () => {
  const jobs = createJobs({ name: 'books', keyOf: (job) => job.key });
  const job = jobs.start('b', async (self) => {
    self.stage = 'failed';
    self.error = 'nope';
  }, {
    finish: false,
    onFinish: (self) => {
      self.finishedAt = 42;
      if (!self.done && self.stage !== 'failed') self.stage = 'done';
      self.done = self.stage === 'done';
    },
  });

  await jobs.whenIdle();
  assert.equal(job.done, false, 'a failed books job is not `done`');
  assert.equal(job.finishedAt, 42);
  assert.equal(job.stage, 'failed');
});

test('status() of an unknown id is null and never throws', () => {
  const jobs = createJobs({ name: 'test' });
  assert.equal(jobs.status('nope'), null);
  assert.equal(jobs.status(null), null);
  assert.equal(jobs.get(undefined), undefined);
});
