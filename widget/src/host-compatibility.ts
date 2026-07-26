export interface HostCompatibilityApi {
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
  callTool?: (
    name: string,
    argumentsValue: Record<string, string>,
  ) => Promise<unknown>;
  sendFollowUpMessage?: (input: {
    prompt: string;
    scrollToBottom?: boolean;
  }) => Promise<unknown>;
}

export interface HostCompatibilityWindow {
  openai?: HostCompatibilityApi;
}

declare global {
  interface Window {
    openai?: HostCompatibilityApi;
  }
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: 'ui/notifications/tool-result';
  params: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolResultNotification(value: unknown): value is JsonRpcNotification {
  return isRecord(value)
    && value.jsonrpc === '2.0'
    && value.method === 'ui/notifications/tool-result'
    && 'params' in value;
}

export async function connectWithTimeout(
  connection: Promise<unknown>,
  timeoutMs = 3_000,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('The host connection timed out.')),
      timeoutMs,
    );
  });
  try {
    await Promise.race([connection, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export function readToolResultNotification(
  event: Pick<MessageEvent<unknown>, 'data' | 'source'>,
  expectedSource: MessageEventSource | null,
): unknown | undefined {
  if (event.source !== expectedSource || !isToolResultNotification(event.data)) return undefined;
  return event.data.params;
}

export function readCompatibilityToolOutput(
  host: HostCompatibilityWindow,
): unknown | undefined {
  const metadata = host.openai?.toolResponseMetadata;
  if (isRecord(metadata) && isRecord(metadata.mcp_tool_result)) {
    return metadata.mcp_tool_result;
  }
  const output = host.openai?.toolOutput;
  if (output === undefined) return undefined;
  return {
    content: [],
    structuredContent: output,
  };
}

export async function callCompatibilityTool(
  host: HostCompatibilityWindow,
  name: string,
  argumentsValue: Record<string, string>,
): Promise<unknown> {
  const callTool = host.openai?.callTool;
  if (callTool === undefined) {
    throw new Error('The host compatibility tool bridge is unavailable.');
  }
  return callTool(name, argumentsValue);
}

export async function sendCompatibilityMessage(
  host: HostCompatibilityWindow,
  prompt: string,
): Promise<unknown> {
  const sendFollowUpMessage = host.openai?.sendFollowUpMessage;
  if (sendFollowUpMessage === undefined) {
    throw new Error('The host compatibility message bridge is unavailable.');
  }
  return sendFollowUpMessage({ prompt, scrollToBottom: true });
}
