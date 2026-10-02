/**
 * LLM adapter types — model-agnostic interface for chat completion with tool calling.
 */

export interface LLMAdapter {
  readonly id: string;
  readonly supportsToolCalling: boolean;
  readonly supportsStreaming: boolean;
  readonly maxContextTokens: number;

  chat(request: ChatRequest): AsyncIterable<ChatChunk>;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type ChatChunk =
  | { type: 'token'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'done'; usage?: { promptTokens: number; completionTokens: number } }
  | { type: 'error'; error: { code: string; message: string } };
