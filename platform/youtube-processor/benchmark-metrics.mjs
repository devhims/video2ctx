// Used only by the separate benchmark entrypoint, never by server.mjs.
import { readFileSync } from 'node:fs';

export function readCounters(path) {
  try {
    return Object.fromEntries(readFileSync(path, 'utf8').trim().split('\n')
      .map(line => line.trim().split(/\s+/)).map(([key, value]) => [key, Number(value)]));
  } catch { return null; }
}

export function counterDelta(before, after) {
  if (!before || !after) return null;
  return Object.fromEntries(Object.keys(after).filter(key => Number.isFinite(before[key]) && Number.isFinite(after[key]))
    .map(key => [key, Math.max(0, after[key] - before[key])]));
}

function readLimit(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch { return null; }
}

export async function measure(fetchOperation) {
  const cpuStat = readCounters('/sys/fs/cgroup/cpu.stat');
  const memoryEvents = readCounters('/sys/fs/cgroup/memory.events');
  const uptimeAtStart = process.uptime();
  const cpu = process.cpuUsage();
  const start = performance.now();
  const response = await fetchOperation();
  const body = await response.text();
  const durationMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const memory = process.memoryUsage();
  return { response, body, metrics: {
    durationMs, processCpuMs: (used.user + used.system) / 1000,
    rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, uptimeAtStart,
    cpuMax: readLimit('/sys/fs/cgroup/cpu.max'),
    memoryCurrent: readLimit('/sys/fs/cgroup/memory.current'),
    memoryPeak: readLimit('/sys/fs/cgroup/memory.peak'),
    memoryMax: readLimit('/sys/fs/cgroup/memory.max'),
    cgroupCpuDelta: counterDelta(cpuStat, readCounters('/sys/fs/cgroup/cpu.stat')),
    cgroupMemoryEventsDelta: counterDelta(memoryEvents, readCounters('/sys/fs/cgroup/memory.events')),
  } };
}
