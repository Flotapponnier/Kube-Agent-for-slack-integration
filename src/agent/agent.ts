import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionToolMessageParam } from 'openai/resources/chat/completions';
import { config } from '../config.ts';
import { executeTool, toolDefinitions } from './tools.ts';

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `You are Mobula's Kubernetes operations assistant. You help the team diagnose and troubleshoot Kubernetes issues.

Your job is to:
1. Understand the user's question about their Kubernetes cluster
2. Use the available tools to gather information (READ-ONLY)
3. Analyze the data and provide a clear diagnosis
4. Suggest actionable solutions

CRITICAL SECURITY RULE:
- You are READ-ONLY. You can ONLY use tools that read/get information.
- You CANNOT delete, restart, scale, or modify any resources.
- If a user asks you to delete/restart/scale something, tell them to use the command builder: "@bot command"
- The command builder has write permissions with confirmation, you do not.
- NEVER attempt to execute destructive operations, even if the user insists.

Guidelines:
- Always start by gathering relevant events if the issue is unclear
- For pod issues, check pod status, describe the pod, and look at logs
- For OOMKill issues, compare memory limits vs actual usage
- For CrashLoopBackOff, check previous logs to see why the container crashed
- Be concise but thorough in your analysis
- If you suggest a fix, provide the exact kubectl command OR tell them to use "@bot command"

SLACK FORMATTING (IMPORTANT - use this syntax, NOT markdown):
- Bold: *text* (NOT **text**)
- Italic: _text_ (NOT *text*)
- Strikethrough: ~text~
- Code inline: \`code\`
- Code block: \`\`\`code\`\`\`
- Bullet points: • or -
- Use emojis for visual clarity: 🔴 🟡 🟢 ⚠️ ✅ ❌ 🔧 📊

RESPONSE FORMAT - Always structure your response like this:

[EMOJI] *TITLE*

*Summary:* One sentence overview

*Details:*
• Item 1: description
• Item 2: description

*Recommended Actions:*
1. First action
2. Second action

\`\`\`
kubectl command here
\`\`\`

Example for pod issues:
🔴 *3 Pods with errors detected*

*Summary:* 3 pods have crash issues in services-prod

*Affected Pods:*
• \`listener-bnb-backfilling-1\` - CrashLoopBackOff (1569 restarts)
• \`listener-zetachain\` - Unstable (1509 restarts)
• \`explorer-api\` - CrashLoopBackOff (361 restarts)

*Probable Cause:* OOMKill - insufficient memory

*Recommended Actions:*
1. Check logs: \`kubectl logs <pod> -n services-prod --previous\`
2. Increase memory limits

Common namespaces in this cluster:
- services-prod: Production services
- services-preprod: Pre-production/staging services
- argocd: ArgoCD deployments
- prometheus-stack: Monitoring

Always provide actionable insights, not just raw data dumps. Keep responses concise and scannable.`;

const MAX_ITERATIONS = 10;

export interface AgentResult {
  answer: string;
  toolsUsed: string[];
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function analyzeQuestion(
  question: string,
  conversationHistory: ConversationMessage[] = [],
): Promise<AgentResult> {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    // Add conversation history for context
    ...conversationHistory.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    })),
    // Add current question
    { role: 'user' as const, content: question },
  ];

  const toolsUsed: string[] = [];
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await openai.chat.completions.create({
      model: config.OPENAI_MODEL,
      messages,
      tools: toolDefinitions,
      tool_choice: 'auto',
    });

    const message = response.choices[0]?.message;
    if (!message) {
      throw new Error('No response from OpenAI');
    }

    // Add assistant message to history
    messages.push(message);

    // Check if we have tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      console.log(`🔧 Agent calling tools: ${message.tool_calls.map((t) => t.function.name).join(', ')}`);

      // Execute all tool calls in parallel
      const toolResults = await Promise.all(
        message.tool_calls.map(async (toolCall) => {
          const args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
          console.log(`  → ${toolCall.function.name}(${JSON.stringify(args)})`);

          const result = await executeTool(toolCall.function.name, args);
          toolsUsed.push(toolCall.function.name);

          return {
            tool_call_id: toolCall.id,
            role: 'tool' as const,
            content: result,
          } satisfies ChatCompletionToolMessageParam;
        }),
      );

      // Add tool results to messages
      messages.push(...toolResults);
    } else {
      // No more tool calls - we have the final answer
      console.log(`✅ Agent finished after ${iterations} iterations`);
      return {
        answer: message.content || 'I was unable to analyze this issue.',
        toolsUsed: [...new Set(toolsUsed)],
      };
    }
  }

  // Max iterations reached
  return {
    answer:
      "⚠️ I've gathered a lot of information but reached my analysis limit. Here's what I found so far - please ask a more specific question if you need more details.",
    toolsUsed: [...new Set(toolsUsed)],
  };
}
