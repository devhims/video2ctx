// Diagnostics stay in operator logs. Never serialize requests, headers, or media URLs.
export function redact(value) {
  let text = String(value ?? '');
  for (const secret of [process.env.OUTBOUND_PROXY_URL]) {
    if (!secret) continue;
    text = text.split(secret).join('[REDACTED]');
    try {
      const url = new URL(secret);
      for (const part of [url.username, url.password]) {
        if (part) for (const token of [part, decodeURIComponent(part)]) text = text.split(token).join('[REDACTED]');
      }
    } catch { /* Not a URL. */ }
  }
  return text.replace(/(?:https?|socks5?|file):\/\/[^\s"'<>\\]+/gi, '[REDACTED_URL]')
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\r\n]+/gi, '[REDACTED_HEADER]')
    .replace(/\b(?:bearer|basic)\s+[^\s"']+/gi, '[REDACTED_AUTH]')
    .replace(/\b(?:token|api[_-]?key|password|secret|signature|sig)\s*[:=]\s*[^\s,;"']+/gi, '[REDACTED_SECRET]')
    .replace(/(?:\/[\w.@%-]+){2,}(?:[\w.@%/-]*)/g, '[REDACTED_PATH]')
    .slice(0, 4000);
}

export function errorDetails(error, depth = 0) {
  if (depth > 3 || error == null) return undefined;
  return {
    name: redact(error.name ?? 'Error'), code: redact(error.code ?? 'UNKNOWN'),
    message: redact(error.message ?? error),
    ...(Number.isInteger(error.status) ? { status: error.status } : {}),
    ...(error.exitCode === null || Number.isInteger(error.exitCode) ? { exitCode: error.exitCode } : {}),
    ...(typeof error.timedOut === 'boolean' ? { timedOut: error.timedOut } : {}),
    ...(error.signal ? { signal: redact(error.signal) } : {}),
    ...(error.stderr ? { stderr: redact(error.stderr) } : {}),
    ...(error.stack ? { stack: redact(error.stack) } : {}),
    ...(error.cause ? { cause: errorDetails(error.cause, depth + 1) } : {}),
  };
}

export function diagnosticDetails(event) {
  const safe = {};
  for (const key of ['stage', 'profile', 'playabilityStatus', 'reason', 'message']) {
    if (typeof event[key] === 'string') safe[key] = redact(event[key]);
  }
  for (const key of ['timestampMs', 'candidateIndex', 'candidateCount', 'status', 'elapsedMs', 'exitCode', 'attempt', 'delayMs', 'width', 'height', 'sourceWidth', 'sourceHeight', 'formatId']) {
    if (Number.isFinite(event[key])) safe[key] = event[key];
  }
  if (event.error) safe.error = errorDetails(event.error);
  return safe;
}

export const logDiagnostic = event => console.error(JSON.stringify(event));
