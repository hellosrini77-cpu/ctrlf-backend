export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { source, query, action, fileId, accessToken } = req.query;

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

    // Get Drive file content (for PDFs, Sheets, etc.)
    if (action === 'getDriveContent' && fileId && accessToken) {
      const result = await getDriveFileContent(fileId, accessToken, req.query.mimeType);
      return res.status(200).json(result);
    }

    // Source search endpoints
    if (!query && !action) {
      return res.status(400).json({ error: 'Query required' });
    }

    let result;
    if (source === 'notion') {
      result = await searchNotion(query);
    } else if (source === 'slack') {
      result = await searchSlack(query);
    } else {
      return res.status(400).json({ error: 'Invalid source or action' });
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
    return { error: 'AI not configured. Add ANTHROPIC_API_KEY to environment variables.', answer: null };
  }

  const systemPrompt = `You are a helpful assistant that answers questions based on the user's files and data.
You have access to search results from their Google Drive, Gmail, Notion, and Slack.

IMPORTANT RULES:
1. Answer ONLY based on the provided context. Do not make up information.
2. Be concise and direct.
3. If asked about counts, numbers, or lists - provide specific numbers from the data.
4. If you find a spreadsheet or list, count the actual items.
5. Always cite which source (Drive, Gmail, Notion, Slack) and file name your answer comes from.
6. If the context doesn't contain enough information to answer, say "I couldn't find that information in your files."

For spreadsheets/CSVs: Look at the data rows and count them accurately.
For waitlists/signups: Each row (after header) typically represents one signup.`;

  const userPrompt = `Question: ${question}

Context from user's files and messages:
${context}

Please answer the question based on this context. Be specific and cite your sources.`;

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
// DRIVE FILE CONTENT EXTRACTION
// ============================================

async function getDriveFileContent(fileId, accessToken, mimeType) {
  try {
    // Google Docs - export as plain text
    if (mimeType && mimeType.includes('document')) {
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      if (!response.ok) throw new Error('Failed to export document');
      const text = await response.text();
      return { content: text.substring(0, 10000), type: 'document' };
    }
    
    // Google Sheets - export as CSV
    if (mimeType && mimeType.includes('spreadsheet')) {
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      if (!response.ok) throw new Error('Failed to export spreadsheet');
      const csv = await response.text();
      return { content: csv.substring(0, 10000), type: 'spreadsheet', rowCount: csv.split('\n').length - 1 };
    }
    
    // Google Slides - export as plain text
    if (mimeType && mimeType.includes('presentation')) {
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      if (!response.ok) throw new Error('Failed to export presentation');
      const text = await response.text();
      return { content: text.substring(0, 10000), type: 'presentation' };
    }
    
    // PDF - download and extract text
    if (mimeType && mimeType.includes('pdf')) {
      try {
        // Download PDF content
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
          { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );
        
        if (!response.ok) {
          return { content: null, type: 'pdf', error: 'Failed to download PDF' };
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        // Try to extract text using pdf-parse
        try {
          const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
          const pdfData = await pdfParse(buffer);
          return { content: pdfData.text.substring(0, 10000), type: 'pdf' };
        } catch (parseError) {
          // If pdf-parse fails, return error
          return { content: null, type: 'pdf', error: 'Could not parse PDF: ' + parseError.message };
        }
      } catch (error) {
        return { content: null, type: 'pdf', error: error.message };
      }
    }
    
    // Plain text files
    if (mimeType && (mimeType.includes('text/') || mimeType.includes('json') || mimeType.includes('csv'))) {
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      if (!response.ok) throw new Error('Failed to download file');
      const text = await response.text();
      return { content: text.substring(0, 10000), type: 'text' };
    }
    
    return { content: null, type: 'unsupported', error: 'File type not supported for content extraction' };
  } catch (error) {
    return { content: null, type: 'error', error: error.message };
  }
}

// ============================================
// NOTION SEARCH WITH CONTENT
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
    body: JSON.stringify({ query, page_size: 10 })
  });

  const result = await response.json();
  if (result.object === 'error') return { error: result.message, pages: [] };

  const pages = [];
  
  for (const item of (result.results || [])) {
    let title = 'Untitled';
    if (item.properties) {
      const titleProp = item.properties.title || item.properties.Name;
      if (titleProp?.title?.[0]) title = titleProp.title[0].plain_text;
    }
    if (item.child_page?.title) title = item.child_page.title;
    
    // Get page content
    let content = '';
    try {
      content = await getNotionPageContent(item.id);
    } catch (e) {
      console.error('Error getting page content:', e);
    }

    pages.push({ 
      id: item.id, 
      title, 
      url: item.url, 
      lastEdited: item.last_edited_time,
      content: content.substring(0, 3000)
    });
  }

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
    const type = block.type;
    const blockData = block[type];
    
    if (blockData?.rich_text) {
      const text = blockData.rich_text.map(t => t.plain_text).join('');
      if (type.includes('heading')) {
        content += `\n## ${text}\n`;
      } else if (type.includes('list')) {
        content += `• ${text}\n`;
      } else {
        content += `${text}\n`;
      }
    }
    
    // Handle tables
    if (type === 'table') {
      content += '\n[Table data]\n';
    }
    
    // Handle child databases (like tables/lists)
    if (type === 'child_database') {
      try {
        const dbContent = await getNotionDatabaseContent(block.id);
        content += dbContent;
      } catch (e) {
        console.error('Error getting database content:', e);
      }
    }
  }

  return content;
}

async function getNotionDatabaseContent(databaseId) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  
  const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ page_size: 100 })
  });

  const data = await response.json();
  let content = `\n[Database with ${data.results?.length || 0} entries]\n`;
  
  for (const row of (data.results || [])) {
    const props = row.properties;
    const rowData = [];
    for (const [key, value] of Object.entries(props)) {
      if (value.title?.[0]?.plain_text) {
        rowData.push(`${key}: ${value.title[0].plain_text}`);
      } else if (value.rich_text?.[0]?.plain_text) {
        rowData.push(`${key}: ${value.rich_text[0].plain_text}`);
      } else if (value.email) {
        rowData.push(`${key}: ${value.email}`);
      } else if (value.number !== undefined) {
        rowData.push(`${key}: ${value.number}`);
      }
    }
    if (rowData.length > 0) {
      content += `- ${rowData.join(', ')}\n`;
    }
  }

  return content;
}

// ============================================
// SLACK SEARCH WITH CONTENT
// ============================================

async function searchSlack(query) {
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  if (!SLACK_BOT_TOKEN) return { error: 'Slack not configured', messages: [] };

  // Try search API first
  const searchResponse = await fetch(
    `https://slack.com/api/search.messages?query=${encodeURIComponent(query)}&count=20`,
    { headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` } }
  );

  const searchResult = await searchResponse.json();
  
  if (searchResult.ok && searchResult.messages?.matches?.length > 0) {
    const messages = searchResult.messages.matches.map(m => ({
      ts: m.ts, 
      text: m.text, 
      channel: m.channel?.name || 'unknown',
      username: m.username || m.user || 'Unknown',
      permalink: m.permalink,
      content: m.text
    }));
    return { messages, count: messages.length };
  }

  // Fallback to channel history search
  return await searchSlackChannels(query, SLACK_BOT_TOKEN);
}

async function searchSlackChannels(query, token) {
  const channelsResponse = await fetch(
    'https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=50',
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  const channelsResult = await channelsResponse.json();
  if (!channelsResult.ok) return { error: channelsResult.error, messages: [] };

  const messages = [];
  const queryLower = query.toLowerCase();
  const channels = (channelsResult.channels || []).filter(c => c.is_member).slice(0, 10);

  for (const channel of channels) {
    try {
      const historyResponse = await fetch(
        `https://slack.com/api/conversations.history?channel=${channel.id}&limit=100`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      const historyResult = await historyResponse.json();
      
      if (historyResult.ok && historyResult.messages) {
        for (const msg of historyResult.messages) {
          if (msg.text && msg.text.toLowerCase().includes(queryLower)) {
            messages.push({
              ts: msg.ts,
              text: msg.text,
              channel: channel.name,
              username: msg.user || 'Unknown',
              permalink: null,
              content: msg.text
            });
          }
        }
      }
    } catch (e) {
      console.error(`Error searching channel ${channel.name}:`, e);
    }
  }

  return { messages: messages.slice(0, 20), count: messages.length };
}
