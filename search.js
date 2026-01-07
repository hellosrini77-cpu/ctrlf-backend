// Vercel Serverless Function for CtrlF Search
// Handles Notion and Slack API calls server-side to avoid CORS

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { source, query } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'Query required' });
  }

  try {
    let result;

    switch (source) {
      case 'notion':
        result = await searchNotion(query);
        break;
      case 'slack':
        result = await searchSlack(query);
        break;
      default:
        return res.status(400).json({ error: 'Invalid source. Use: notion, slack' });
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error('Search error:', error);
    return res.status(500).json({ error: error.message });
  }
}

// ============================================
// NOTION SEARCH
// ============================================

async function searchNotion(query) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;

  if (!NOTION_TOKEN) {
    return { error: 'Notion not configured', pages: [] };
  }

  const response = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: query,
      page_size: 20
    })
  });

  const result = await response.json();

  if (result.object === 'error') {
    return { error: result.message, pages: [] };
  }

  const pages = (result.results || []).map(item => {
    let title = 'Untitled';

    // Extract title from different page types
    if (item.properties) {
      const titleProp = item.properties.title || item.properties.Name || item.properties.name;
      if (titleProp && titleProp.title && titleProp.title[0]) {
        title = titleProp.title[0].plain_text;
      }
    }

    // For child pages
    if (item.child_page && item.child_page.title) {
      title = item.child_page.title;
    }

    return {
      id: item.id,
      title: title,
      url: item.url,
      lastEdited: item.last_edited_time,
      type: item.object
    };
  });

  return {
    pages: pages,
    count: pages.length
  };
}

// ============================================
// SLACK SEARCH
// ============================================

async function searchSlack(query) {
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

  if (!SLACK_BOT_TOKEN) {
    return { error: 'Slack not configured', messages: [] };
  }

  // Try search.messages first (requires search:read scope)
  const searchUrl = `https://slack.com/api/search.messages?query=${encodeURIComponent(query)}&count=20`;

  const searchResponse = await fetch(searchUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
    }
  });

  const searchResult = await searchResponse.json();

  if (searchResult.ok && searchResult.messages && searchResult.messages.matches) {
    const messages = searchResult.messages.matches.map(match => ({
      ts: match.ts,
      text: match.text,
      channel: match.channel.name,
      username: match.username,
      permalink: match.permalink
    }));

    return {
      messages: messages,
      count: messages.length
    };
  }

  // Fallback: search through channels manually
  return await searchSlackChannels(query, SLACK_BOT_TOKEN);
}

async function searchSlackChannels(query, token) {
  // Get list of channels
  const channelsResponse = await fetch('https://slack.com/api/conversations.list?types=public_channel&limit=100', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  const channelsResult = await channelsResponse.json();

  if (!channelsResult.ok) {
    return { error: channelsResult.error, messages: [] };
  }

  const messages = [];
  const queryLower = query.toLowerCase();

  // Search through each channel (limit to first 5 for performance)
  const channels = (channelsResult.channels || []).filter(c => c.is_member).slice(0, 5);

  for (const channel of channels) {
    const historyResponse = await fetch(`https://slack.com/api/conversations.history?channel=${channel.id}&limit=50`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    const historyResult = await historyResponse.json();

    if (historyResult.ok && historyResult.messages) {
      historyResult.messages.forEach(msg => {
        if (msg.text && msg.text.toLowerCase().includes(queryLower)) {
          messages.push({
            ts: msg.ts,
            text: msg.text.substring(0, 200),
            channel: channel.name,
            username: msg.user || 'Unknown',
            permalink: null
          });
        }
      });
    }
  }

  return {
    messages: messages.slice(0, 20),
    count: messages.length
  };
}
