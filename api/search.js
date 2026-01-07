export default async function handler(req, res) {
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
    if (source === 'notion') {
      result = await searchNotion(query);
    } else if (source === 'slack') {
      result = await searchSlack(query);
    } else {
      return res.status(400).json({ error: 'Invalid source' });
    }
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

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

  const pages = (result.results || []).map(item => {
    let title = 'Untitled';
    if (item.properties) {
      const titleProp = item.properties.title || item.properties.Name;
      if (titleProp?.title?.[0]) title = titleProp.title[0].plain_text;
    }
    if (item.child_page?.title) title = item.child_page.title;
    return { id: item.id, title, url: item.url, lastEdited: item.last_edited_time };
  });

  return { pages, count: pages.length };
}

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
      ts: m.ts, text: m.text, channel: m.channel.name, username: m.username, permalink: m.permalink
    }));
    return { messages, count: messages.length };
  }

  return { messages: [], count: 0 };
}
