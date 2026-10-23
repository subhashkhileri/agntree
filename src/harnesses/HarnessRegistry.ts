import { HarnessId } from '../types';
import { HarnessAdapter } from './types';

/**
 * Lookup and installation detection for the supported harnesses.
 */
export class HarnessRegistry {
  private readonly adapters = new Map<HarnessId, HarnessAdapter>();
  private readonly installedCache = new Map<HarnessId, boolean>();
  private readonly installedProbes = new Map<HarnessId, Promise<boolean>>();

  constructor(adapters: HarnessAdapter[]) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.id, adapter);
    }
  }

  get(id: HarnessId): HarnessAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`Unknown harness: ${id}`);
    }
    return adapter;
  }

  all(): HarnessAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Whether the harness is installed. Concurrent callers share one probe so
   * activation and the first tree render do not run `which` twice.
   */
  async isInstalled(id: HarnessId, refresh = false): Promise<boolean> {
    if (!refresh) {
      const cached = this.installedCache.get(id);
      if (cached !== undefined) {
        return cached;
      }
    }

    const inFlight = this.installedProbes.get(id);
    if (inFlight) {
      return inFlight;
    }

    const probe = (async () => {
      try {
        return await this.get(id).isInstalled();
      } catch {
        return false;
      }
    })();

    this.installedProbes.set(id, probe);
    try {
      const installed = await probe;
      this.installedCache.set(id, installed);
      return installed;
    } finally {
      this.installedProbes.delete(id);
    }
  }

  async getInstalled(): Promise<HarnessAdapter[]> {
    const results = await Promise.all(
      this.all().map(async (adapter) => ({
        adapter,
        installed: await this.isInstalled(adapter.id),
      }))
    );

    return results.filter((result) => result.installed).map((result) => result.adapter);
  }

  /** True when more than one harness is available; used to label sessions. */
  async hasMultipleInstalled(): Promise<boolean> {
    return (await this.getInstalled()).length > 1;
  }
}
