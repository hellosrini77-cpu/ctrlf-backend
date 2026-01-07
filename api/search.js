export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { source, query, action } = req.query;

  try {
    // AI Answer endpoint
    if (action === 'answer') {
      let body = {};
      if (req.method === 'POST') {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      }
      const question = body.question || query;
      const context = body.context || '';
      const result = await generateAnswer(question, context);
      return res.status(200).json(result);
    }

    // Source search endpoints
    if (!query) {
      return res.status(400).json({ error: 'Query required' });
    }

    let result;
    if (source === 'notion') {
      result = await searchNotion(query);
    } else if (source === 'slack') {
      result = await searchSlack(query);
    } else {
      return res.status(400).json({ error: 'Invalid source' });
    }
    return res.status(200).json(result);
  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ error: error.message });
  }
}

// ============================================
// AI ANSWER GENERATION
// ============================================

async function generateAnswer(question, context) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  
  if (!ANTHROPIC_API_KEY) {
    return { error: 'AI not configured', answer: null };
  }

  const systemPrompt = `You are a helpful assistant that answers questions based on the user's files and data. 
You have access to search results from their Google Drive, Gmail, Notion, and Slack.
Answer the question based ONLY on the provided context. If you can't find the answer in the context, say so.
Be concise and direct. If asked about counts or numbers, provide the specific number if available.
Always cite which source (Drive, Gmail, Notion, Slack) your answer comes from.`;

  const userPrompt = `Question: ${question}

Context from user's files and messages:
${context}

Please answer the question based on this context.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: userPrompt }
        ],
        system: systemPrompt
      })
    });

    const data = await response.json();
    
    if (data.error) {
      return { error: data.error.message, answer: null };
    }

    return { 
      answer: data.content[0].text,
      model: 'claude-sonnet-4-20250514'
    };
  } catch (error) {
    return { error: error.message, answer: null };
  }
}

// ============================================
// NOTION SEARCH
// ============================================

async function searchNotion(query) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  if (!NOTION_TOKEN) return { error: 'Notion not configured', pages: [] };

  const response = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, page_size: 20 })
  });

  const result = await response.json();
  if (result.object === 'error') return { error: result.message, pages: [] };

  const pages = await Promise.all((result.results || []).map(async item => {
    let title = 'Untitled';
    if (item.properties) {
      const titleProp = item.properties.title || item.properties.Name;
      if (titleProp?.title?.[0]) title = titleProp.title[0].plain_text;
    }
    if (item.child_page?.title) title = item.child_page.title;
    
    // Get page content for AI context
    let content = '';
    try {
      content = await getNotionPageContent(item.id);
    } catch (e) {
      console.error('Error getting page content:', e);
    }

    return { 
      id: item.id, 
      title, 
      url: item.url, 
      lastEdited: item.last_edited_time,
      content: content.substring(0, 2000) // Limit content size
    };
  }));

  return { pages, count: pages.length };
}

async function getNotionPageContent(pageId) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  
  const response = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28'
    }
  });

  const data = await response.json();
  let content = '';

  for (const block of (data.results || [])) {
    if (block.type === 'paragraph' && block.paragraph?.rich_text) {
      content += block.paragraph.rich_text.map(t => t.plain_text).join('') + '\n';
    } else if (block.type === 'heading_1' && block.heading_1?.rich_text) {
      content += '# ' + block.heading_1.rich_text.map(t => t.plain_text).join('') + '\n';
    } else if (block.type === 'heading_2' && block.heading_2?.rich_text) {
      content += '## ' + block.heading_2.rich_text.map(t => t.plain_text).join('') + '\n';
    } else if (block.type === 'bulleted_list_item' && block.bulleted_list_item?.rich_text) {
      content += '• ' + block.bulleted_list_item.rich_text.map(t => t.plain_text).join('') + '\n';
    } else if (block.type === 'numbered_list_item' && block.numbered_list_item?.rich_text) {
      content += '- ' + block.numbered_list_item.rich_text.map(t => t.plain_text).join('') + '\n';
    }
  }

  return content;
}

// ============================================
// SLACK SEARCH
// ============================================

async function searchSlack(query) {
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  if (!SLACK_BOT_TOKEN) return { error: 'Slack not configured', messages: [] };

  const searchResponse = await fetch(
    `https://slack.com/api/search.messages?query=${encodeURIComponent(query)}&count=20`,
    { headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` } }
  );

  const searchResult = await searchResponse.json();
  if (searchResult.ok && searchResult.messages?.matches) {
    const messages = searchResult.messages.matches.map(m => ({
      ts: m.ts, 
      text: m.text, 
      channel: m.channel.name, 
      username: m.username, 
      permalink: m.permalink,
      content: m.text // For AI context
    }));
    return { messages, count: messages.length };
  }

  // Fallback: search through channels
  return await searchSlackChannels(query, SLACK_BOT_TOKEN);
}

async function searchSlackChannels(query, token) {
  const channelsResponse = await fetch('https://slack.com/api/conversations.list?types=public_channel&limit=100', {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const channelsResult = await channelsResponse.json();
  if (!channelsResult.ok) return { error: channelsResult.error, messages: [] };

  const messages = [];
  const queryLower = query.toLowerCase();
  const channels = (channelsResult.channels || []).filter(c => c.is_member).slice(0, 5);

  for (const channel of channels) {
    const historyResponse = await fetch(`https://slack.com/api/conversations.history?channel=${channel.id}&limit=50`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const historyResult = await historyResponse.json();
    if (historyResult.ok && historyResult.messages) {
      historyResult.messages.forEach(msg => {
        if (msg.text && msg.text.toLowerCase().includes(queryLower)) {
          messages.push({
            ts: msg.ts,
            text: msg.text.substring(0, 500),
            channel: channel.name,
            username: msg.user || 'Unknown',
            permalink: null,
            content: msg.text
          });
        }
      });
    }
  }

  return { messages: messages.slice(0, 20), count: messages.length };
}
