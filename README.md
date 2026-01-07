# CtrlF Backend

Serverless API for CtrlF - handles Notion and Slack search.

## Deploy to Vercel

### 1. Create GitHub Repo

```bash
cd ctrlf-backend
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/ctrlf-backend.git
git push -u origin main
```

### 2. Deploy to Vercel

1. Go to [vercel.com](https://vercel.com)
2. Sign in with GitHub
3. Click **Add New → Project**
4. Import `ctrlf-backend` repository
5. Click **Deploy**

### 3. Add Environment Variables

In Vercel Dashboard:
1. Go to your project → **Settings → Environment Variables**
2. Add:
   -  NOTION_TOKEN='your_notion_token_here'
   -  SLACK_BOT_TOKEN='your_slack_bot_token_here'
3. Click **Save**
4. **Redeploy** for changes to take effect

### 4. Get Your API URL

Your API will be at:
```
https://ctrlf-backend.vercel.app/api/search
```

Or whatever Vercel assigns (e.g., `https://ctrlf-backend-xyz.vercel.app`)

### 5. Update Frontend

In your `index.html`, update:
```javascript
VERCEL_API_URL: 'https://ctrlf-backend.vercel.app'
```

## API Endpoints

### Search Notion
```
GET /api/search?source=notion&query=your+search+term
```

### Search Slack
```
GET /api/search?source=slack&query=your+search+term
```

## Local Development

```bash
npm install -g vercel
vercel dev
```

Create `.env.local` with your tokens for local testing.
