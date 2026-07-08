import emailService from './email-service';

const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

const aiAgentService = {
  /**
   * 获取 AI chat 流式响应
   */
  async chatStream(c, params) {
    const { messages, tools, temperature, max_tokens, accountId } = params;

    if (!accountId) {
      throw new Error('Cloudflare Account ID is required');
    }

    const account = await getAccountById(c, accountId);
    if (!account || !account.token) {
      throw new Error('Cloudflare account not found or token invalid');
    }

    const formattedMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    const requestBody = {
      messages: formattedMessages,
      stream: true,
    };

    if (temperature !== undefined) {
      requestBody.temperature = Number(temperature);
    }

    if (max_tokens !== undefined) {
      requestBody.max_tokens = Number(max_tokens);
    }

    if (tools && tools.length > 0) {
      requestBody.tools = tools;
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/run/${AI_MODEL}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${account.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI API error: ${errorText}`);
    }

    return response;
  },

  /**
   * 获取邮件列表
   */
  async listEmails(c, params) {
    const { folder, limit, offset, domain } = params;
    const emailList = await emailService.list(c, {
      size: limit || 20,
      type: folderToEmailType(folder),
      domain,
      emailId: offset ? String(offset) : undefined,
    });
    return emailList;
  },

  /**
   * 读取邮件详情
   */
  async readEmail(c, params) {
    const { emailId, domain } = params;
    const list = await emailService.latest(c, {
      emailId: Number(emailId),
      type: 'receive',
      domain,
    });
    return list.length > 0 ? list[0] : null;
  },

  /**
   * 搜索邮件
   */
  async searchEmails(c, params) {
    const { query, folder, limit, domain } = params;
    const emailList = await emailService.list(c, {
      size: limit || 20,
      type: folderToEmailType(folder),
      domain,
    });

    const searchTerms = query.toLowerCase().split(/\s+/);
    return emailList.list.filter((e) => {
      const searchText = [
        e.subject,
        e.text,
        e.fromEmail,
        e.toEmail,
        e.fromName,
        e.toName,
      ]
        .join(' ')
        .toLowerCase();
      return searchTerms.every((term) => searchText.includes(term));
    });
  },

  /**
   * 起草新邮件（仅返回数据，不发送）
   */
  async draftEmail(c, params) {
    const { to, subject, content, cc, bcc } = params;
    return {
      draftId: `draft_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      to,
      cc,
      bcc,
      subject,
      content,
      status: 'draft',
    };
  },

  /**
   * 起草回复邮件
   */
  async draftReply(c, params) {
    const { emailId, content, replyAll, domain } = params;
    const list = await emailService.latest(c, {
      emailId: Number(emailId),
      type: 'receive',
      domain,
    });

    if (!list || list.length === 0) {
      throw new Error(`Email ${emailId} not found`);
    }

    const original = list[0];
    const originalSubject = original.subject.startsWith('Re:')
      ? original.subject
      : `Re: ${original.subject}`;

    const replyPrefix = replyAll ? 'Reply All' : 'Reply';
    const replyHeader = `\n\n--- ${replyPrefix} ---\nFrom: ${original.fromName} <${original.fromEmail}>\nDate: ${original.createTime}\nSubject: ${original.subject}\n\n`;

    return {
      draftId: `reply_${emailId}_${Date.now()}`,
      to: original.fromEmail,
      subject: originalSubject,
      content: replyHeader + content,
      status: 'draft',
    };
  },

  /**
   * 起草转发邮件
   */
  async draftForward(c, params) {
    const { emailId, content, to, domain } = params;
    const list = await emailService.latest(c, {
      emailId: Number(emailId),
      type: 'receive',
      domain,
    });

    if (!list || list.length === 0) {
      throw new Error(`Email ${emailId} not found`);
    }

    const original = list[0];
    const forwardHeader = `\n\n--- Forwarded ---\nFrom: ${original.fromName} <${original.fromEmail}>\nDate: ${original.createTime}\nSubject: ${original.subject}\nTo: ${original.toEmail}\n\n`;

    return {
      draftId: `forward_${emailId}_${Date.now()}`,
      to,
      subject: `Fwd: ${original.subject}`,
      content: forwardHeader + content,
      status: 'draft',
    };
  },

  /**
   * 发送邮件
   */
  async sendEmail(c, params) {
    const { draftEmail, domain } = params;
    // The AI agent doesn't have a From-picker; before the
    // decoupling pass the worker derived the sender itself
    // (resolving an empty display-name to `no-reply@<domain>`).
    // The new shape has the caller resolve the From address, so
    // we do that here. `fromName` is omitted on purpose — the
    // worker falls back to the local-part capitalised, so the
    // row's `from_name` shows "No-reply" and there's no surprise
    // for the recipient.
    const sendResult = await emailService.dispatchOutbound(c, {
      from: `no-reply@${domain}`,
      to: draftEmail.to,
      subject: draftEmail.subject,
      text: draftEmail.content,
      content: draftEmail.content,
      attachments: draftEmail.attachments,
      domain,
    });
    return {
      success: true,
      emailId: sendResult[0]?.emailId,
      message: `Email sent to ${draftEmail.to.join(', ')}`,
    };
  },

  /**
   * 标记邮件已读
   */
  async markRead(c, params) {
    const { emailId, read } = params;
    if (read) {
      await emailService.read(c, { emailIds: [Number(emailId)] });
    }
    return { success: true, emailId: Number(emailId), read };
  },

  /**
   * 删除邮件
   */
  async deleteEmail(c, params) {
    const { emailId } = params;
    await emailService.delete(c, { emailIds: [Number(emailId)] });
    return { success: true, emailId: Number(emailId) };
  },
};

/**
 * 将文件夹名称映射到邮件类型
 */
function folderToEmailType(folder) {
  switch (folder) {
    case 'inbox':
      return 'receive';
    case 'sendbox':
    case 'drafts':
    case 'archive':
    case 'trash':
      return 'send';
    default:
      return 'receive';
  }
}

/**
 * 根据账户 ID 获取账户信息
 */
async function getAccountById(c, accountId) {
  const stmt = c.env.db.prepare(
    'SELECT token FROM server_account WHERE id = ? AND is_active = 1'
  );
  const result = await stmt.bind(accountId).first();
  return result;
}

export default aiAgentService;
