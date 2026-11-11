import * as fs from 'fs';
import * as path from 'path';
import {
  OpencodeSessionInfo,
  OpencodeSessionService,
  toHarnessSession,
} from '../services/OpencodeSessionService';
import { clampInlineText } from '../utils/text';
import { HarnessSession, PreviewMessage, SessionSearchSource } from './types';

/** opencode session IDs are safe path segments; anything else is not one. */
const SESSION_ID = /^ses_[A-Za-z0-9_-]+$/;
const SNAPSHOT_DIR = 'opencode-sessions';
/** The snapshot is recent history, not the whole database. */
const MAX_SESSIONS = 200;
const PREPARE_BUDGET_MS = 45_000;
/** A hard ceiling on the bytes written into the search folder. */
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const CONCURRENCY = 6;
/** The opening words are what a quote needs; a whole essay is not. */
const MAX_SNAPSHOT_PROMPT = 4_000;

export interface OpencodeSearchOptions {
  /** How long the whole snapshot may take; tests shorten it. */
  budgetMs?: number;
  /** How many bytes the snapshot files may hold; tests shorten it. */
  maxBytes?: number;
}

/**
 * opencode sessions as a search source. Its database is off limits, so the
 * source asks the official CLI/API for the user's messages and writes one
 * compact JSON file per session into the search's own folder. The agent
 * greps that snapshot; it is removed with the folder, and nothing is indexed
 * or kept between searches.
 */
export class OpencodeSessionSearch implements SessionSearchSource {
  constructor(
    private readonly sessions: OpencodeSessionService,
    private readonly options: OpencodeSearchOptions = {}
  ) {}

  readableDirs(): string[] {
    // The snapshot lives in the search's cwd, which every runner can read.
    return [];
  }

  instructions(): string {
    return [
      '- opencode keeps sessions in its own database, which Agntree may not read directly. For this search Agntree used opencode\'s documented CLI/API to write a read-only snapshot; the prepared instructions below say where it is and what it contains.',
    ].join('\n');
  }

  async prepare({
    cwd,
    signal,
  }: {
    cwd: string;
    signal: AbortSignal;
  }): Promise<string> {
    const budgetMs = this.options.budgetMs ?? PREPARE_BUDGET_MS;
    const maxBytes = this.options.maxBytes ?? MAX_SNAPSHOT_BYTES;
    // The budget covers the whole preparation, including the session listing;
    // otherwise a slow list could consume it before any message is fetched.
    const deadline = Date.now() + budgetMs;
    const all = await this.sessions.listAllSessions({ signal, deadline });
    const selected = all.slice(0, MAX_SESSIONS);
    const dir = path.join(cwd, SNAPSHOT_DIR);
    await fs.promises.mkdir(dir, { recursive: true });

    const entries: Array<{ session: OpencodeSessionInfo; prompts: PreviewMessage[] }> = [];
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        signal.throwIfAborted();
        if (Date.now() >= deadline) {
          return;
        }
        const index = next++;
        if (index >= selected.length) {
          return;
        }
        const session = selected[index];
        try {
          const prompts = await this.sessions.listUserMessages(session.id, undefined, signal);
          if (prompts.length > 0) {
            entries.push({ session, prompts });
          }
        } catch {
          signal.throwIfAborted();
          // One unreadable session does not remove the rest of the source.
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(CONCURRENCY, selected.length) },
        () => worker()
      )
    );
    signal.throwIfAborted();

    entries.sort(
      (a, b) => (b.session.time?.updated ?? 0) - (a.session.time?.updated ?? 0)
    );

    let written = 0;
    let writtenBytes = 0;
    let truncated = false;
    for (const { session, prompts } of entries) {
      if (!SESSION_ID.test(session.id)) {
        continue;
      }
      // JSON.stringify gives the key order the instructions promise. The
      // closing brace is dropped so the prompts array can follow it.
      const head = JSON.stringify({
        sessionId: session.id,
        cwd: session.location.directory,
        title: session.title ?? null,
        updated: session.time?.updated ?? null,
        agent: session.agent ?? null,
      }).slice(0, -1);
      const open = `${head},"prompts":[`;
      const close = ']}';
      let room = maxBytes - writtenBytes - Buffer.byteLength(open + close, 'utf8');
      if (room < 0) {
        truncated = true;
        break;
      }
      const parts: string[] = [];
      for (const prompt of prompts) {
        const part = JSON.stringify({
          time: prompt.timestamp,
          text: clampInlineText(prompt.text, MAX_SNAPSHOT_PROMPT),
        });
        const cost = Buffer.byteLength(part, 'utf8') + (parts.length > 0 ? 1 : 0);
        if (cost > room) {
          truncated = true;
          break;
        }
        parts.push(part);
        room -= cost;
      }
      if (parts.length === 0) {
        // Metadata without a prompt is not a session a search can use.
        truncated = true;
        break;
      }
      const serialized = `${open}${parts.join(',')}${close}`;
      await fs.promises.writeFile(path.join(dir, `${session.id}.json`), serialized, 'utf8');
      writtenBytes += Buffer.byteLength(serialized, 'utf8');
      written += 1;
      if (parts.length < prompts.length) {
        truncated = true;
      }
    }

    return [
      `- The snapshot is ${dir}: one JSON file per session, holding ${written} recent top-level, non-archived sessions that fit this search's preparation.`,
      written === 0
        ? '- No opencode session with a user prompt could be prepared, so opencode cannot match this question.'
        : '- Each file is {"sessionId","cwd","title","updated","agent","prompts":[{"time","text"}]}. "prompts" are the user\'s own messages, oldest first; "time" and "updated" are epoch milliseconds. Match the question against the prompts, then use the title, cwd, and time to choose.',
      truncated
        ? '- The snapshot reached its size budget, so some sessions or later prompts are absent.'
        : '',
      '- Older sessions, archived sessions, and subagent sessions are absent. If nothing in the snapshot matches, say so rather than guessing.',
      `- The snapshot is capped at ${maxBytes} bytes; Grep or Read only the files that match.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  async verify(
    sessionId: string,
    quote: string
  ): Promise<{ session: HarnessSession; prompt?: PreviewMessage } | null> {
    if (!SESSION_ID.test(sessionId)) {
      return null;
    }
    // A failing API rejects, and the finder drops the match.
    const found = await this.sessions.findSessionPrompt(sessionId, quote);
    return found ? { session: toHarnessSession(found.session), prompt: found.prompt } : null;
  }
}
