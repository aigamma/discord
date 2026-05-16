// Anthropic tool-use loop. Sends the conversation to Sonnet, executes any
// tools the model invokes, feeds results back, repeats until the model
// stops. Capped at MAX_TOOL_ROUNDS so a buggy tool can't run away with the
// turn.

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { buildSystemPrompt } from './prompt.js';
import { getToolSpecs, executeTool } from './tools/index.js';

const MAX_TOOL_ROUNDS = 5;
const MAX_TOKENS = 2048;

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

export async function answer(userMessage) {
  const tools = getToolSpecs();
  const messages = [{ role: 'user', content: userMessage }];

  let toolUsesThisTurn = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(),
      tools: tools.length ? tools : undefined,
      messages,
    });

    if (response.stop_reason !== 'tool_use') {
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { text, toolUses: toolUsesThisTurn };
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];
    for (const block of toolUseBlocks) {
      toolUsesThisTurn.push({ name: block.name, input: block.input });
      const result = await executeTool(block.name, block.input);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    text: '_(Hit the tool-use round limit before reaching a final answer. Try rephrasing the question.)_',
    toolUses: toolUsesThisTurn,
  };
}
