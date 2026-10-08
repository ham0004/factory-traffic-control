import type { JunctionService } from './junctionService';

// Signal timing is driven by a 1s tick fed into the same per-junction queue as every other input.
// No request handler ever sleeps.
export function startTicker(service: JunctionService, intervalMs = 1000): () => void {
  const timer = setInterval(() => {
    for (const junctionId of service.junctionIds()) {
      service.tick(junctionId).catch((err) => console.error(`tick failed for junction ${junctionId}:`, err));
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
