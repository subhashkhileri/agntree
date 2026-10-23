import * as os from 'os';
import * as path from 'path';

/**
 * Single source of truth for the hook log: the installer writes commands that
 * append to it and the attention service tails it.
 */
const ATTENTION_DIR_NAME = '.agntree';
const ATTENTION_FILE_NAME = 'attention.jsonl';

export const ATTENTION_DIR = path.join(os.homedir(), ATTENTION_DIR_NAME);
export const ATTENTION_FILE = path.join(ATTENTION_DIR, ATTENTION_FILE_NAME);

/**
 * The command Claude Code's hooks run: append each payload (one JSON object
 * per line) to the log. POSIX only and deliberately dependency-free — the hook
 * gets the event on stdin and the payload names its own event. `$HOME` is
 * expanded by the hook's shell, so one settings file serves any user.
 */
export const ATTENTION_HOOK_COMMAND =
  `mkdir -p "$HOME/${ATTENTION_DIR_NAME}" && { cat; printf '\\n'; } >> ` +
  `"$HOME/${ATTENTION_DIR_NAME}/${ATTENTION_FILE_NAME}"`;
