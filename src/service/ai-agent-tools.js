/**
 * AI Agent 工具定义
 */

export const ToolDefinitions = [
  {
    name: 'list_emails',
    description: '获取邮件列表，用于查看收件箱、发件箱等文件夹中的邮件。返回邮件摘要列表。',
    parameters: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: '文件夹名称: inbox(收件箱), sendbox(发件箱), drafts(草稿箱), archive(归档), trash(垃圾箱)',
        },
        limit: {
          type: 'number',
          description: '返回邮件数量，默认为 20',
        },
        offset: {
          type: 'number',
          description: '分页偏移量，默认为 0',
        },
      },
    },
  },
  {
    name: 'read_email',
    description: '读取指定邮件的完整内容，包括正文和附件信息。',
    parameters: {
      type: 'object',
      properties: {
        emailId: {
          type: 'number',
          description: '邮件 ID',
        },
      },
      required: ['emailId'],
    },
  },
  {
    name: 'search_emails',
    description: '在邮件中搜索关键词，返回匹配的邮件列表。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，可以是发件人、主题、内容中的词',
        },
        folder: {
          type: 'string',
          description: '可选，限定搜索的文件夹',
        },
        limit: {
          type: 'number',
          description: '返回结果数量限制，默认为 20',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'draft_email',
    description: '起草一封新邮件，返回草稿数据（不会自动发送）。',
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'array',
          items: { type: 'string' },
          description: '收件人邮箱地址数组',
        },
        subject: {
          type: 'string',
          description: '邮件主题',
        },
        content: {
          type: 'string',
          description: '邮件正文内容（支持富文本）',
        },
        cc: {
          type: 'array',
          items: { type: 'string' },
          description: '抄送邮箱地址数组（可选）',
        },
        bcc: {
          type: 'array',
          items: { type: 'string' },
          description: '密送邮箱地址数组（可选）',
        },
      },
      required: ['to', 'subject', 'content'],
    },
  },
  {
    name: 'draft_reply',
    description: '起草一封回复邮件，自动填充收件人和原邮件信息。',
    parameters: {
      type: 'object',
      properties: {
        emailId: {
          type: 'number',
          description: '要回复的原始邮件 ID',
        },
        content: {
          type: 'string',
          description: '回复正文内容',
        },
        replyAll: {
          type: 'boolean',
          description: '是否回复所有人，默认为 false',
        },
      },
      required: ['emailId', 'content'],
    },
  },
  {
    name: 'draft_forward',
    description: '起草一封转发邮件，包含原邮件内容。',
    parameters: {
      type: 'object',
      properties: {
        emailId: {
          type: 'number',
          description: '要转发的原始邮件 ID',
        },
        content: {
          type: 'string',
          description: '转发附言',
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: '转发收件人邮箱地址数组',
        },
      },
      required: ['emailId', 'content', 'to'],
    },
  },
  {
    name: 'send_email',
    description: '发送一封草稿邮件。草稿数据应包含收件人、主题和内容。',
    parameters: {
      type: 'object',
      properties: {
        draftEmail: {
          type: 'object',
          description: '草稿邮件数据',
          properties: {
            to: {
              type: 'array',
              items: { type: 'string' },
              description: '收件人邮箱地址数组',
            },
            subject: {
              type: 'string',
              description: '邮件主题',
            },
            content: {
              type: 'string',
              description: '邮件正文',
            },
            cc: {
              type: 'array',
              items: { type: 'string' },
              description: '抄送地址（可选）',
            },
            bcc: {
              type: 'array',
              items: { type: 'string' },
              description: '密送地址（可选）',
            },
          },
        },
      },
      required: ['draftEmail'],
    },
  },
  {
    name: 'mark_read',
    description: '标记邮件为已读或未读状态。',
    parameters: {
      type: 'object',
      properties: {
        emailId: {
          type: 'number',
          description: '邮件 ID',
        },
        read: {
          type: 'boolean',
          description: 'true 标记为已读，false 标记为未读',
        },
      },
      required: ['emailId', 'read'],
    },
  },
  {
    name: 'delete_email',
    description: '删除邮件，将其移至垃圾箱。',
    parameters: {
      type: 'object',
      properties: {
        emailId: {
          type: 'number',
          description: '邮件 ID',
        },
      },
      required: ['emailId'],
    },
  },
];
