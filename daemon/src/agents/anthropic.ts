import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam as MessageParam, BetaMessage as Message, BetaToolUnion as ToolUnion,
  BetaToolResultBlockParam as ToolResultBlockParam, BetaContentBlockParam as ContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { RunContext, type Tool } from '@openai/agents';
import { config } from '../config.ts';
import { recordUsage } from '../usage/recorder.ts';
import { priceOpusUsage } from '../usage/pricing.ts';

export type ClaudeHistory = MessageParam[];
export interface ClaudeResult { text: string; history: ClaudeHistory; exhausted: boolean; container?: string }
export interface ClaudeRunOptions {
  instructions: string;
  input: string | ClaudeHistory;
  tools?: Tool[];
  signal?: AbortSignal;
  maxTurns?: number;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  model?: string;
  taskId?: string;
  kind?: string;
  container?: string;
  onText?: (delta: string) => void;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  /** Transport injection for deterministic tests; production always constructs the official SDK. */
  client?: Anthropic;
}

export class ClaudeProviderError extends Error {
  kind: 'auth' | 'quota' | 'timeout' | 'network' | 'http' | 'incomplete';
  status?: number;
  constructor(kind: ClaudeProviderError['kind'], status?: number) {
    super(`Anthropic ${kind}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'ClaudeProviderError';
    this.kind = kind;
    this.status = status;
  }
}

function providerError(error: unknown): ClaudeProviderError {
  const e = error as { status?: number; name?: string };
  return new ClaudeProviderError(
    e.status === 401 || e.status === 403 ? 'auth' : e.status === 429 ? 'quota' :
    e.name?.includes('Timeout') ? 'timeout' : e.status ? 'http' : 'network', e.status,
  );
}

/** Keep existing validated tool invokers and their approval/steering wrappers intact. */
export function claudeTools(tools: Tool[]): ToolUnion[] {
  return tools.map((tool): ToolUnion => {
    if (tool.type === 'function') {
      return { name: tool.name, description: tool.description, input_schema: {
        ...tool.parameters, required: tool.parameters.required?.map(String),
      } };
    }
    if (tool.type === 'hosted_tool' && tool.name === 'code_interpreter') {
      return { type: 'code_execution_20260521', name: 'code_execution' };
    }
    throw new Error(`No Anthropic transport for tool ${tool.type}:${'name' in tool ? tool.name : ''}`);
  });
}

function recordMessage(message: Message, opts: ClaudeRunOptions) {
  const u = message.usage;
  recordUsage({
    provider: 'anthropic', model: message.model, kind: opts.kind ?? 'subagent_run', taskId: opts.taskId,
    inputTokens: u.input_tokens, outputTokens: u.output_tokens,
    cachedTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    costUsd: priceOpusUsage(u), billed: true,
    detail: { cache_creation: u.cache_creation, server_tool_use: u.server_tool_use },
  });
}

/** Messages loop: retain every assistant block, including opaque thinking signatures and
 * server-tool results. Tool results remain correlated by tool_use_id across continuation. */
export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeResult> {
  const client = opts.client ?? new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY ?? 'unset',
    timeout: config.models.requestTimeoutMs, maxRetries: 2,
  });
  const history: ClaudeHistory = typeof opts.input === 'string'
    ? [{ role: 'user', content: opts.input }] : structuredClone(opts.input);
  const tools = opts.tools ?? [];
  const definitions = claudeTools(tools);
  const context = new RunContext();
  let container = opts.container;
  let text = '';
  for (let turn = 0; turn < (opts.maxTurns ?? 12); turn++) {
    opts.signal?.throwIfAborted();
    let message: Message;
    try {
      const stream = client.beta.messages.stream({
        betas: ['thinking-display-updates-2026-08-18'],
        model: opts.model ?? config.models.worker,
        max_tokens: opts.maxTokens ?? config.models.workerMaxOutputTokens,
        output_config: { effort: opts.effort ?? 'high' },
        thinking: { type: 'adaptive', display: 'updates' },
        system: opts.instructions,
        messages: history,
        ...(definitions.length ? { tools: definitions, tool_choice: { type: 'auto' as const } } : {}),
        ...(container ? { container } : {}),
      }, { signal: opts.signal });
      // Only the public text channel is surfaced. Private thinking stays in history.
      stream.on('text', delta => opts.onText?.(delta));
      message = await stream.finalMessage();
    } catch (error) {
      opts.signal?.throwIfAborted();
      throw providerError(error);
    }
    recordMessage(message, opts);
    opts.signal?.throwIfAborted();
    history.push({ role: 'assistant', content: message.content });
    container = message.container?.id ?? container;
    text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
    if (text) opts.onEvent?.('subagent.message', { text });
    for (const block of message.content) {
      if (block.type === 'thinking' && block.thinking) opts.onEvent?.('subagent.thought', { text: block.thinking });
      else if (block.type === 'server_tool_use') opts.onEvent?.('tool.call', { name: block.name, args: JSON.stringify(block.input) });
      else if (block.type.endsWith('_tool_result')) opts.onEvent?.('tool.result', { output: JSON.stringify(block) });
    }
    const calls = message.content.filter(b => b.type === 'tool_use');
    if (message.stop_reason === 'max_tokens') throw new ClaudeProviderError('incomplete');
    if (calls.length) {
      const results: ToolResultBlockParam[] = [];
      const seen = new Set<string>();
      // Sequential dispatch preserves deterministic UI action/observation ordering.
      for (const call of calls) {
        opts.signal?.throwIfAborted();
        if (seen.has(call.id)) throw new Error('Duplicate Anthropic tool call id');
        seen.add(call.id);
        const target = tools.find(t => t.type === 'function' && t.name === call.name);
        opts.onEvent?.('tool.call', { name: call.name, args: JSON.stringify(call.input) });
        let output: unknown;
        let isError = false;
        if (!target || target.type !== 'function') {
          output = `Unknown tool: ${call.name}`;
          isError = true;
        } else if (await target.needsApproval(context, call.input as never, call.id)) {
          // Current Gumbo tools perform their existing confirmations inside invoke().
          // A future SDK-level approval cannot silently become an allowed operation.
          output = 'Tool requires an approval handler before it can execute.';
          isError = true;
        } else {
          output = await target.invoke(context, JSON.stringify(call.input));
        }
        opts.signal?.throwIfAborted();
        const content = typeof output === 'string' ? output : JSON.stringify(output ?? null);
        results.push({ type: 'tool_result', tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
        opts.onEvent?.('tool.result', { output: content });
      }
      history.push({ role: 'user', content: results });
      continue;
    }
    if (message.stop_reason === 'pause_turn') continue; // server tools resume with unchanged assistant blocks
    if (!text.trim()) throw new ClaudeProviderError('incomplete');
    return { text, history, exhausted: false, container };
  }
  return { text, history, exhausted: true, container };
}

export async function claudeText(instructions: string, input: string | ContentBlockParam[],
  signal?: AbortSignal, kind = 'completion', model = config.models.worker): Promise<string> {
  const result = await runClaude({ instructions, input: [{ role: 'user', content: input }], signal, kind, model, maxTurns: 1 });
  if (result.exhausted) throw new ClaudeProviderError('incomplete');
  return result.text;
}
