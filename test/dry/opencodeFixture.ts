/**
 * A fake `opencode` CLI. Its state is a JSON file that the Node fixture reads
 * and records each call into, so tests need no opencode install or server.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fakeCli, tempDir } from './support';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'fake-opencode.js');

export interface OpencodeState {
  sessions: object[];
  exports: Record<string, { messages: object[] }>;
  calls: string[][];
  failMove?: boolean;
  serviceDown?: boolean;
  listDelayMs?: number;
  messageDelayMs?: number;
  terminated?: number;
}

/** A fake CLI at `cli` playing `state`, with accessors for what it recorded. */
export function fakeOpencode(t: { after(fn: () => void): void }, state: Omit<OpencodeState, 'calls'>) {
  const dir = tempDir(t, 'agntree-opencode-');
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, calls: [] }));
  const read = (): OpencodeState => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return {
    cli: fakeCli(dir, 'opencode', FIXTURE, { FAKE_OPENCODE_STATE: stateFile }),
    dir,
    read,
    update: (change: Partial<OpencodeState>) => fs.writeFileSync(stateFile, JSON.stringify({ ...read(), ...change })),
    /** How many calls ran `operation`. */
    calls: (operation: string) => read().calls.filter((args) => args.includes(operation)).length,
  };
}
