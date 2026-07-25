import {
  CallToolResultSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { gameContextSchema, type GameContext } from './game-context.js';

export type GameContextToolResultErrorCode =
  | 'UNRECOGNIZED_HOST_ENVELOPE'
  | 'TOOL_ERROR'
  | 'MISSING_STRUCTURED_CONTENT'
  | 'INVALID_STRUCTURED_CONTENT';

export interface SafeContractIssue {
  path: string;
  code: string;
  expected?: string;
  receivedType: string;
}

export interface SafeToolResultDiagnostic {
  rootType: string;
  isEvent: boolean;
  isCustomEvent: boolean;
  ownKeys: string[];
  properties: Array<{
    path: string;
    present: boolean;
    type: string;
  }>;
}

export class GameContextToolResultError extends Error {
  constructor(
    readonly code: GameContextToolResultErrorCode,
    message: string,
    readonly diagnostics?: SafeToolResultDiagnostic | SafeContractIssue[],
  ) {
    super(message);
    this.name = 'GameContextToolResultError';
  }
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function readPath(input: unknown, path: readonly string[]): { present: boolean; value: unknown } {
  let current = input;
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) {
      return { present: false, value: undefined };
    }
    current = current[segment];
  }
  return { present: true, value: current };
}

function isEventInstance(input: unknown): boolean {
  return typeof Event !== 'undefined' && input instanceof Event;
}

function isToolResultCustomEvent(input: unknown): input is CustomEvent<unknown> {
  if (!isRecord(input)) return false;
  const isCustomEvent = (
    (typeof CustomEvent !== 'undefined' && input instanceof CustomEvent)
    || Object.prototype.toString.call(input) === '[object CustomEvent]'
  );
  return isCustomEvent && input.type === 'toolresult' && 'detail' in input;
}

function hasToolResultSignature(input: unknown): boolean {
  if (!isRecord(input)) return false;
  return ['content', 'structuredContent', 'isError'].some(
    (key) => Object.prototype.hasOwnProperty.call(input, key),
  );
}

export function describeToolResultBoundary(input: unknown): SafeToolResultDiagnostic {
  const relevantPaths = [
    ['detail'],
    ['params'],
    ['result'],
    ['content'],
    ['structuredContent'],
    ['isError'],
    ['_meta'],
    ['detail', 'params'],
    ['detail', 'result'],
    ['detail', 'content'],
    ['detail', 'structuredContent'],
    ['detail', 'isError'],
    ['detail', '_meta'],
  ] as const;

  return {
    rootType: Object.prototype.toString.call(input),
    isEvent: isEventInstance(input),
    isCustomEvent: isToolResultCustomEvent(input),
    ownKeys: isRecord(input)
      ? Reflect.ownKeys(input).map((key) => typeof key === 'symbol' ? 'symbol' : key).sort()
      : [],
    properties: relevantPaths.map((path) => {
      const inspected = readPath(input, path);
      return {
        path: path.join('.'),
        present: inspected.present,
        type: inspected.present ? valueType(inspected.value) : 'absent',
      };
    }),
  };
}

export function normalizeToolResultEvent(input: unknown): CallToolResult {
  if (hasToolResultSignature(input)) {
    const direct = CallToolResultSchema.safeParse(input);
    if (direct.success) return direct.data;
  }

  if (isToolResultCustomEvent(input) && hasToolResultSignature(input.detail)) {
    const detail = CallToolResultSchema.safeParse(input.detail);
    if (detail.success) return detail.data;
  }

  throw new GameContextToolResultError(
    'UNRECOGNIZED_HOST_ENVELOPE',
    'O host entregou o resultado da ferramenta em um envelope não reconhecido.',
    describeToolResultBoundary(input),
  );
}

function safeContractIssues(input: unknown, issues: readonly {
  path: PropertyKey[];
  code: string;
  expected?: unknown;
}[]): SafeContractIssue[] {
  return issues.map((issue) => {
    const path = issue.path.map(String);
    const inspected = readPath(input, path);
    return {
      path: path.join('.'),
      code: issue.code,
      ...(typeof issue.expected === 'string' ? { expected: issue.expected } : {}),
      receivedType: inspected.present ? valueType(inspected.value) : 'absent',
    };
  });
}

export function parseGameContextToolResult(input: unknown): GameContext {
  const result = normalizeToolResultEvent(input);

  if (result.isError === true) {
    throw new GameContextToolResultError(
      'TOOL_ERROR',
      'A ferramenta informou que não foi possível carregar o contexto público.',
    );
  }

  if (result.structuredContent === undefined) {
    throw new GameContextToolResultError(
      'MISSING_STRUCTURED_CONTENT',
      'A ferramenta não incluiu o contexto público estruturado.',
    );
  }

  const parsed = gameContextSchema.safeParse(result.structuredContent);
  if (!parsed.success) {
    throw new GameContextToolResultError(
      'INVALID_STRUCTURED_CONTENT',
      'O contexto público retornado pela ferramenta não corresponde ao contrato esperado.',
      safeContractIssues(result.structuredContent, parsed.error.issues),
    );
  }

  return parsed.data;
}
