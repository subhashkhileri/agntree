/**
 * The shared incremental JSONL reader that Codex rollouts and Pi records use.
 * A counting fold makes "only the appended bytes were read" observable: a
 * reader that re-read the file would fold earlier entries again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JsonlAppendReader } from '../../src/utils/jsonlAppendReader';
import { tempDir } from './support';

const line = (value: object) => `${JSON.stringify(value)}\n`;

function setup(
  t: { after(fn: () => void): void },
  options: { verifyFirstLine?: boolean } = {}
) {
  const file = path.join(tempDir(t, 'agntree-append-'), 'record.jsonl');
  let folds = 0;
  const reader = new JsonlAppendReader<{ values: unknown[] }, unknown[]>(
    {
      initial: () => ({ values: [] }),
      apply: (entry, state) => {
        folds++;
        state.values.push((entry as { n?: unknown }).n);
      },
      result: (state) => [...state.values],
      verifyFirstLine: options.verifyFirstLine,
    },
    10
  );
  return { file, reader, folds: () => folds };
}

test('a later read folds only the appended entries, and a partial line waits for its newline', async (t) => {
  const { file, reader, folds } = setup(t);
  fs.writeFileSync(file, line({ n: 1 }) + line({ n: 2 }));
  assert.deepEqual(await reader.read(file), [1, 2]);

  fs.appendFileSync(file, `${line({ n: 3 })}{"n":4`);
  assert.deepEqual(await reader.read(file), [1, 2, 3]);

  fs.appendFileSync(file, '}\n');
  assert.deepEqual(await reader.read(file), [1, 2, 3, 4]);
  assert.equal(folds(), 4, 'each entry is folded once');
});

test('a file rewritten in place is read again from the start: shorter, or with a changed first line', async (t) => {
  const { file, reader } = setup(t, { verifyFirstLine: true });
  fs.writeFileSync(file, line({ n: 'header-v2' }) + line({ n: 1 }));
  assert.deepEqual(await reader.read(file), ['header-v2', 1]);

  // A longer rewrite: reading on from the old offset would land mid-entry.
  fs.writeFileSync(
    file,
    line({ n: 'header-v3', note: 'migrated' }) + line({ n: 1 }) + line({ n: 2 })
  );
  assert.deepEqual(await reader.read(file), ['header-v3', 1, 2]);

  fs.writeFileSync(file, line({ n: 'short' }));
  assert.deepEqual(await reader.read(file), ['short']);
});

test('concurrent reads of one file share a single pass', async (t) => {
  const { file, reader, folds } = setup(t);
  fs.writeFileSync(file, line({ n: 1 }) + line({ n: 2 }) + line({ n: 3 }));

  const [first, second] = await Promise.all([reader.read(file), reader.read(file)]);
  assert.deepEqual(first, [1, 2, 3]);
  assert.deepEqual(second, [1, 2, 3]);
  assert.equal(folds(), 3);
});
