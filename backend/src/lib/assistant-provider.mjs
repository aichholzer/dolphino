import { Transform, pipeline } from 'node:stream';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { isProviderConfigured, verifyBedrockAvailability } from './llm.mjs';
const INPUT_BYTES = 128 * 1024,
  OUTPUT_BYTES = 64 * 1024;
const OWN_ERROR = Symbol('assistant-provider-error');
const MODEL_REQUEST_REJECTED =
  'The configured model rejected the assistant request. Choose a model with tool-calling support and run its compatibility test in Settings → AI features.';
const failure = (message, status = 502) =>
  Object.assign(Error(message), { status, expose: true, [OWN_ERROR]: message });
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function bounded(value, limit) {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > limit) {
    throw failure('Assistant context or response exceeds its size limit', 400);
  }

  return encoded;
}

// OpenAI strict mode requires every object closed and every property required;
// optional values are represented explicitly with a nullable type. Traverse nested
// schemas instead of assuming a strict marker on the root is sufficient.
export function isStrictToolSchema(schema) {
  const visited = new Set();
  function walk(node, depth = 0) {
    if (!plain(node) || depth > 32) {
      return false;
    }

    if (visited.has(node)) {
      return true;
    }

    visited.add(node);
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes('object') || node.properties !== undefined) {
      if (node.additionalProperties !== false || !plain(node.properties) || !Array.isArray(node.required)) {
        return false;
      }

      const names = Object.keys(node.properties);
      if (
        new Set(node.required).size !== names.length ||
        node.required.length !== names.length ||
        !names.every((name) => node.required.includes(name))
      ) {
        return false;
      }

      if (!Object.values(node.properties).every((child) => walk(child, depth + 1))) {
        return false;
      }
    }

    if (types.includes('array') && (!plain(node.items) || !walk(node.items, depth + 1))) {
      return false;
    }

    if (
      node.anyOf !== undefined &&
      (!Array.isArray(node.anyOf) || !node.anyOf.length || !node.anyOf.every((child) => walk(child, depth + 1)))
    ) {
      return false;
    }

    if (
      node.$defs !== undefined &&
      (!plain(node.$defs) || !Object.values(node.$defs).every((child) => walk(child, depth + 1)))
    ) {
      return false;
    }

    // Unsupported composition cannot establish the closed/required guarantees.
    if (node.allOf || node.oneOf || node.not || node.if || node.then || node.else || node.$ref) {
      return false;
    }

    return types.every((type) =>
      [undefined, 'object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(type)
    );
  }

  return schema?.type === 'object' && walk(schema);
}

function toolResult(entry) {
  if (typeof entry.content === 'string') {
    try {
      return JSON.parse(entry.content);
    } catch {
      throw failure('Invalid assistant tool result', 400);
    }
  }

  return entry.content;
}

function history(messages, provider) {
  const result = [];
  for (const entry of messages) {
    if (!plain(entry)) {
      throw failure('Invalid assistant history', 400);
    }

    if (entry.provider) {
      if (entry.provider !== provider || !plain(entry.item)) {
        throw failure('Assistant provider context changed; start a new conversation', 409);
      }

      result.push(entry.item);
      continue;
    }

    if (entry.role === 'user' && typeof entry.content === 'string') {
      result.push(
        provider === 'openai'
          ? { role: 'user', content: entry.content }
          : { role: 'user', content: [{ text: entry.content }] }
      );
    } else if (entry.role === 'tool' && typeof entry.toolCallId === 'string' && entry.toolCallId.length <= 200) {
      const value = toolResult(entry);
      if (provider === 'openai') {
        result.push({
          type: 'function_call_output',
          call_id: entry.toolCallId,
          output: bounded(value, INPUT_BYTES)
        });
      } else {
        const block = {
          toolResult: {
            toolUseId: entry.toolCallId,
            content: [{ json: value }]
          }
        };
        const previous = result.at(-1);
        if (previous?.role === 'user' && previous.content?.every((item) => item.toolResult)) {
          previous.content.push(block);
        } else {
          result.push({ role: 'user', content: [block] });
        }
      }
    } else {
      throw failure('Invalid assistant history', 400);
    }
  }

  return result;
}

async function responseJson(response) {
  if (!response.ok) {
    await response.body?.cancel?.();
    if ([400, 422].includes(response.status)) {
      throw failure(MODEL_REQUEST_REJECTED);
    }

    throw failure('Assistant provider unavailable; verify model access and credentials');
  }

  const declared = Number(response.headers.get('content-length'));
  if (declared > OUTPUT_BYTES) {
    await response.body?.cancel?.();
    throw failure('Assistant provider response exceeded its size limit');
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw failure('Assistant provider returned an invalid response');
  }

  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      size += value.byteLength;
      if (size > OUTPUT_BYTES) {
        await reader.cancel();
        throw failure('Assistant provider response exceeded its size limit');
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw failure('Assistant provider returned an invalid response');
  }
}

function boundBedrockWireResponse(client) {
  // Runs inside the SDK deserializer: bound raw response bytes before JSON decode.
  client.middlewareStack.addRelativeTo(
    (next) => async (args) => {
      const result = await next(args),
        response = result.response;
      if (!response) {
        return result;
      }

      if (Number(response.headers?.['content-length']) > OUTPUT_BYTES) {
        response.body?.destroy?.();
        throw failure('Assistant provider response exceeded its size limit');
      }

      const source = response.body;
      if (source?.pipe) {
        let size = 0;
        const boundedStream = new Transform({
          transform(chunk, _encoding, done) {
            size += chunk.length;
            if (size > OUTPUT_BYTES) {
              done(failure('Assistant provider response exceeded its size limit'));
            } else {
              done(null, chunk);
            }
          }
        });
        pipeline(source, boundedStream, () => {});
        response.body = boundedStream;
      } else if (source && Buffer.byteLength(source) > OUTPUT_BYTES) {
        throw failure('Assistant provider response exceeded its size limit');
      }

      return result;
    },
    {
      name: 'dolphinoAssistantResponseBound',
      relation: 'after',
      toMiddleware: 'deserializerMiddleware'
    }
  );
}

function validateCalls(calls) {
  if (calls.length > 8) {
    throw failure('Assistant provider returned too many tool calls');
  }

  const seen = new Set();
  for (const call of calls) {
    if (
      typeof call.id !== 'string' ||
      !call.id.length ||
      call.id.length > 200 ||
      seen.has(call.id) ||
      typeof call.name !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(call.name) ||
      !plain(call.arguments)
    ) {
      throw failure('Assistant provider returned invalid tool calls');
    }

    seen.add(call.id);
  }

  return calls;
}

/** Only the server orchestrator may supply tool definitions/native history. This
 * adapter parses calls; the executor separately authorizes and schema-validates them. */
export async function sendAssistantTurn(
  { config, system, messages, tools, signal, assertConfiguration, finalAnswer = false },
  deps = {}
) {
  const assertCurrent = async () => {
    await assertConfiguration?.();
    await deps.assertConfiguration?.();
  };

  if (!['openai', 'bedrock'].includes(config.llmProvider) || !isProviderConfigured(config)) {
    throw failure('Configure an assistant provider and model first', 409);
  }

  if (
    typeof system !== 'string' ||
    system.length > 12000 ||
    !Array.isArray(messages) ||
    messages.length > 128 ||
    !Array.isArray(tools) ||
    tools.length > 16
  ) {
    throw failure('Invalid assistant request', 400);
  }

  for (const tool of tools) {
    if (
      (tool.strict === true && !isStrictToolSchema(tool.parameters)) ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool.name) ||
      typeof tool.description !== 'string' ||
      tool.description.length > 2000 ||
      !plain(tool.parameters)
    ) {
      throw failure('Invalid assistant tool definition', 400);
    }
  }

  // Answers use the model's own maximum length. Only the synthetic provider test sets a cap.
  const maxTokens = config.assistantMaxOutputTokens;
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1)) {
    throw failure('Invalid assistant output limit', 400);
  }

  const deadline = AbortSignal.timeout(60000);
  const abortSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  if (abortSignal.aborted) {
    throw failure('Assistant request cancelled', 409);
  }

  const input = history(messages, config.llmProvider);
  bounded({ system, input, tools }, INPUT_BYTES);
  try {
    if (config.llmProvider === 'openai') {
      await assertCurrent();
      const response = await (deps.fetchImpl ?? fetch)('https://api.openai.com/v1/responses', {
        method: 'POST',
        redirect: 'error',
        signal: abortSignal,
        headers: {
          Authorization: `Bearer ${config.llmApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: config.llmModel,
          instructions: system,
          input,
          store: false,
          parallel_tool_calls: false,
          ...(finalAnswer ? { tool_choice: 'none' } : {}),
          ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
          include: ['reasoning.encrypted_content'],
          tools: tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: tool.strict === false ? false : isStrictToolSchema(tool.parameters)
          }))
        })
      });
      const body = await responseJson(response);
      if (abortSignal.aborted) {
        throw failure('Assistant request cancelled', 409);
      }

      if (body.status && body.status !== 'completed') {
        throw failure('Assistant provider returned incomplete output; try a shorter question');
      }

      if (!Array.isArray(body.output) || body.output.length > 32) {
        throw failure('Assistant provider returned an invalid response');
      }

      const toolCalls = [];
      let text = '';
      for (const item of body.output) {
        if (!plain(item)) {
          throw failure('Assistant provider returned an invalid response');
        }

        if (item.type === 'function_call') {
          if (typeof item.arguments !== 'string') {
            throw failure('Assistant provider returned invalid tool arguments');
          }

          let args;
          try {
            args = JSON.parse(item.arguments);
          } catch {
            throw failure('Assistant provider returned invalid tool arguments');
          }

          toolCalls.push({
            id: item.call_id,
            name: item.name,
            arguments: args
          });
        }

        if (item.type === 'message') {
          for (const part of item.content ?? []) {
            if (part.type === 'output_text' && typeof part.text === 'string') {
              text += part.text;
            } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
              text += part.refusal;
            }
          }
        }
      }

      return {
        text,
        toolCalls: validateCalls(toolCalls),
        continuation: body.output.map((item) => ({ provider: 'openai', item }))
      };
    }

    await verifyBedrockAvailability(config, { ...deps, signal: abortSignal, assertConfiguration: assertCurrent });
    await assertCurrent();
    if (abortSignal.aborted) {
      throw failure('Assistant request cancelled', 409);
    }

    const client =
      deps.bedrockClient ??
      new BedrockRuntimeClient({
        region: config.llmRegion,
        credentials: {
          accessKeyId: config.llmAccessKeyId,
          secretAccessKey: config.llmSecretAccessKey
        },
        maxAttempts: 1,
        ignoreConfiguredEndpointUrls: true,
        ...(deps.bedrockRequestHandler ? { requestHandler: deps.bedrockRequestHandler } : {})
      });
    if (!deps.bedrockClient) {
      boundBedrockWireResponse(client);
    }

    let body;
    try {
      await assertCurrent();
      body = await client.send(
        new ConverseCommand({
          modelId: config.llmModel,
          system: [{ text: system }],
          messages: input,
          ...(maxTokens ? { inferenceConfig: { maxTokens } } : {}),
          ...(tools.length
            ? {
                toolConfig: {
                  tools: tools.map((tool) => ({
                    toolSpec: {
                      name: tool.name,
                      description: tool.description,
                      inputSchema: { json: tool.parameters }
                    }
                  }))
                }
              }
            : {})
        }),
        { abortSignal }
      );
    } finally {
      if (!deps.bedrockClient) {
        client.destroy();
      }
    }

    if (abortSignal.aborted) {
      throw failure('Assistant request cancelled', 409);
    }

    bounded(body, OUTPUT_BYTES);
    if (body.stopReason && !['end_turn', 'tool_use', 'stop_sequence'].includes(body.stopReason)) {
      throw failure('Assistant provider returned incomplete output; try a shorter question');
    }

    const message = body.output?.message;
    if (message?.role !== 'assistant' || !Array.isArray(message.content) || message.content.length > 32) {
      throw failure('Assistant provider returned an invalid response');
    }

    const toolCalls = [];
    let text = '';
    for (const part of message.content) {
      if (typeof part.text === 'string') {
        text += part.text;
      }

      if (part.toolUse) {
        toolCalls.push({
          id: part.toolUse.toolUseId,
          name: part.toolUse.name,
          arguments: part.toolUse.input
        });
      }
    }

    return {
      text,
      toolCalls: validateCalls(toolCalls),
      continuation: [{ provider: 'bedrock', item: message }]
    };
  } catch (error) {
    if (abortSignal.aborted) {
      throw failure('Assistant request cancelled or timed out', 409);
    }

    if (error?.[OWN_ERROR]) {
      throw failure(error[OWN_ERROR], error.status);
    }

    if (error?.name === 'ValidationException') {
      throw failure(MODEL_REQUEST_REJECTED);
    }

    throw failure('Assistant provider unavailable; verify model access and credentials');
  }
}
