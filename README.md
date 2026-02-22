# Newsletter Manager

Turn any website into email updates. No servers, no databases — just GitHub.

## How It Works

1. You add website URLs to `data/sources.json`
2. You add your email to `data/subscribers.json`
3. GitHub Actions runs daily, scrapes those sites, and emails you **only when there's new content**

## Quick Start

### Step 1: Fork This Repo

Click the **Fork** button at the top-right of this page.

### Step 2: Get a Resend API Key

1. Go to [resend.com](https://resend.com) and sign up (free)
2. Go to **API Keys** in the dashboard
3. Click **Create API Key**, copy it

Free tier: 100 emails/day, 3,000/month.

### Step 3: Add GitHub Secrets

In your forked repo:

1. Go to **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**, add:

| Name | Value |
|------|-------|
| `RESEND_API_KEY` | Your Resend API key |
| `FROM_EMAIL` | `onboarding@resend.dev` |

> Use `onboarding@resend.dev` for testing. Once you add a custom domain on Resend, switch to your own address.

### Step 4: Enable GitHub Actions

Forked repos have Actions disabled. Go to the **Actions** tab and click **"I understand my workflows, go ahead and enable them"**.

### Step 5: Edit Your Sources

Edit `data/sources.json`:

```json
{
  "sources": [
    {
      "url": "https://example.com/",
      "name": "Example web"
    },
    {
      "url": "https://example2.com/blog",
      "name": "Example Blog"
    }
  ]
}
```

### Step 6: Add Your Email

Edit `data/subscribers.json`:

```json
{
  "subscribers": [
    "your-real-email@gmail.com"
  ]
}
```

### Step 7: Test It

1. Go to **Actions** tab
2. Click **"Check for Updates"** on the left
3. Click **"Run workflow"** dropdown → **"Run workflow"** button
4. Check the logs to see results

## How the Schedule Works

The workflow runs daily at 08:00 UTC by default. Edit `.github/workflows/check.yml` to change:

```yaml
schedule:
  - cron: '0 8 * * *'    # Daily at 08:00 UTC
  # - cron: '0 0 * * *'  # Daily at midnight UTC
  # - cron: '0 */6 * * *' # Every 6 hours
```

## Project Structure

```
├── index.html                    # Management page (GitHub Pages)
├── data/
│   ├── sources.json              # Websites to track (you edit this)
│   ├── subscribers.json          # Email recipients (you edit this)
│   └── cache.json                # Article cache (auto-managed)
├── scripts/
│   └── check.mjs                 # Scraper + email sender
├── .github/
│   └── workflows/
│       └── check.yml             # Scheduled workflow
└── package.json
```

## Enable GitHub Pages (optional)

To use the management page:

1. Go to **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: **main**, folder: **/ (root)**
4. Save

Your management page will be at `https://YOUR_USERNAME.github.io/newsletter-manager/`

## FAQ

**Q: Why no email for a site I added?**
The scraper works best with server-rendered HTML. JavaScript-heavy SPAs (single-page apps) may return limited content. The scraper will still extract article links and titles from whatever HTML is available.

**Q: Can I add more than one email?**
Yes. Add multiple emails to the subscribers array:
```json
{ "subscribers": ["a@gmail.com", "b@gmail.com"] }
```

**Q: How do I stop getting emails?**
Remove your email from `data/subscribers.json`, or disable the workflow in the Actions tab.

**Q: The Action failed, what do I check?**
Go to Actions tab → click the failed run → check the logs. Common issues: missing secrets, invalid API key, or the website blocking requests.
