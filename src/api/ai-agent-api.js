import app from '../hono/hono';
import result from '../utils/result';
import aiAgentService from '../service/ai-agent-service';
import { ToolDefinitions } from '../service/ai-agent-tools';

/**
 * AI Agent Chat 端点 - 流式响应
 */
app.post('/agent/chat', async (c) => {
  const body = await c.req.json();
  const { messages, tools, temperature, max_tokens, accountId, domain } = body;

  try {
    const response = await aiAgentService.chatStream(c, {
      messages,
      tools: tools || ToolDefinitions,
      temperature,
      max_tokens,
      accountId,
      domain,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return c.json(result.fail(`AI service error: ${errorText}`, response.status));
    }

    return new Response(response.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (err) {
    console.error('AI chat error:', err);
    return c.json(result.fail(err.message, 500));
  }
});

/**
 * 工具执行端点
 */
app.post('/agent/tools/call', async (c) => {
  const body = await c.req.json();
  const { toolName, params, domain } = body;

  try {
    let result;
    switch (toolName) {
      case 'list_emails':
        result = await aiAgentService.listEmails(c, { ...params, domain });
        break;
      case 'read_email':
        result = await aiAgentService.readEmail(c, { ...params, domain });
        break;
      case 'search_emails':
        result = await aiAgentService.searchEmails(c, { ...params, domain });
        break;
      case 'draft_email':
        result = await aiAgentService.draftEmail(c, params);
        break;
      case 'draft_reply':
        result = await aiAgentService.draftReply(c, { ...params, domain });
        break;
      case 'draft_forward':
        result = await aiAgentService.draftForward(c, { ...params, domain });
        break;
      case 'send_email':
        result = await aiAgentService.sendEmail(c, { draftEmail: params.draftEmail, domain });
        break;
      case 'mark_read':
        result = await aiAgentService.markRead(c, params);
        break;
      case 'delete_email':
        result = await aiAgentService.deleteEmail(c, params);
        break;
      default:
        return c.json(result.fail(`Unknown tool: ${toolName}`, 400));
    }

    return c.json(result.ok(result));
  } catch (err) {
    console.error(`Tool ${toolName} error:`, err);
    return c.json(result.fail(err.message, 500));
  }
});
