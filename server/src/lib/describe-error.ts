export type DescribedError = {
  message: string;
  name?: string;
  stack?: string;
  code?: string;
  cause?: DescribedError;
  value?: string;
};

/**
 * Turn an unknown thrown value into a plain, always-loggable object.
 *
 * Pino's `err` serializer drops non-Error throwables and (with `singleLine`
 * pretty transports) can render an empty payload, which is how
 * "heartbeat timer tick failed" logged every 30s with no diagnosable detail.
 */
export function describeError(err: unknown, depth = 3): DescribedError {
  if (err instanceof Error) {
    const described: DescribedError = { message: err.message, name: err.name };
    if (err.stack) described.stack = err.stack;
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") described.code = String(code);
    if (err.cause !== undefined && err.cause !== null && depth > 0) {
      described.cause = describeError(err.cause, depth - 1);
    }
    return described;
  }

  if (err === null || err === undefined) {
    return { message: String(err) };
  }

  if (typeof err === "object") {
    const record = err as Record<string, unknown>;
    const message =
      typeof record.message === "string" && record.message.length > 0
        ? record.message
        : safeStringify(err);
    const described: DescribedError = { message };
    if (typeof record.name === "string") described.name = record.name;
    if (typeof record.code === "string" || typeof record.code === "number") {
      described.code = String(record.code);
    }
    if (typeof record.stack === "string") described.stack = record.stack;
    described.value = safeStringify(err);
    return described;
  }

  return { message: String(err), value: String(err) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
