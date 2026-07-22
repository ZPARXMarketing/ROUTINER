# Claude Routine Planner

[![Netlify Status](https://api.netlify.com/api/v1/badges/your-badge-id/deploy-status)](https://app.netlify.com/sites/zroutiner/deploys)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Built with Supabase](https://img.shields.io/badge/Built%20with-Supabase-green)](https://supabase.com)

> **A powerful Claude Code routine planner and scheduler** that orchestrates AI agents to execute scheduled tasks with intelligent work delegation.

Built on the [ZPARX design system](https://github.com/zparxmarketing/zparxbrand-design), Routiner lets you create, schedule, and manage AI-powered routines that run automatically across multiple Claude accounts.

---

## 🎯 Quick Start

### For Users
1. **Visit** [zroutiner.netlify.app](https://zroutiner.netlify.app)
2. **Sign in** with your email/password
3. **Create a routine** by writing a prompt
4. **Choose an action**: Run now, Schedule, or Save to library

### For Developers (Self-Hosting)
```bash
# 1. Clone the repository
git clone https://github.com/zparxmarketing/zroutiner.git
cd zroutiner

# 2. Set up Supabase
#    - Create a project at supabase.com
#    - Run supabase/schema.sql in the SQL editor
#    - Update credentials in js/app.js

# 3. Deploy to Netlify
#    - Connect your GitHub repo to Netlify
#    - Set environment variables (see Setup section below)
#    - Deploy!
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Planner UI                          │
│                   (index.html + js/app.js)                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
    ┌──────────┐    ┌──────────┐    ┌──────────────┐
    │   Auth   │    │   CRUD   │    │   Run Now    │
    │  (Sign)  │    │Operations│    │  (Trigger)   │
    └────┬─────┘    └────┬─────┘    └──────┬───────┘
         │               │                  │
         └───────────────┴──────────────────┘
                         │
         ┌───────────────▼────────────────┐
         │      Supabase Backend          │
         │  (routiner_routines/runs)      │
         │     + Row-Level Security       │
         └───────────────┬────────────────┘
                         │
         ┌───────────────▼────────────────┐
         │   Netlify Functions             │
         │  (claude-trigger.mjs)           │
         └───────────────┬────────────────┘
                         │
         ┌───────────────▼────────────────┐
         │   Claude Code Routines         │
         │    (Parallel Execution)        │
         │                                │
         │  ┌──────┐  ┌──────┐  ┌──────┐│
         │  │ A    │  │ B    │  │ C    ││
         │  │Agent │  │Agent │  │Agent ││
         │  └──────┘  └──────┘  └──────┘│
         └────────────────────────────────┘
```

---

## ✨ Features

### Core Capabilities

| Feature | Description |
|---------|-------------|
| ▶ **Run Now** | Fire your Claude routine immediately with the current prompt |
| ⏰ **Schedule** | Queue prompts for specific dates/times with repeat options (daily/weekdays/weekly) |
| ▣ **Save to Library** | Store prompts for later iteration and refinement |
| ⧉ **Manage** | Copy, archive, restore, and delete prompts across states |
| ⚡ **Test Live** | Instant preview via Messages API (requires Anthropic key) |

### 🤖 Intelligent Agent Orchestration

Routiner isn't just one assistant—it's a **coordinated swarm of scheduled Claude agents**:

- **Parallel Execution** — Multiple triggers (A/B/C) fire as independent, simultaneous sessions. A week's work executes automatically across accounts without manual oversight.

- **Smart Decomposition** — Complex tasks break into ordered sequences across appropriate time horizons (hour → week), ensuring multi-step projects finish in order and on schedule.

- **Cost-Optimized Delegation** — The orchestrator agent handles judgment calls while delegating grunt work (boilerplate, first drafts, focused coding sub-tasks) to faster, cheaper models via **GLM through OpenRouter**, reviewing every line before shipping.

- **Real-Time Usage Tracking** — Every delegated call logs token count and dollar cost to a live dashboard (`usage.html`), giving you complete visibility into agent activity and spend.

---

## 🔧 Setup

### Prerequisites

- Supabase account (free tier works)
- Netlify account (free tier works)
- Anthropic API key (for Claude routines)

### 1️⃣ Supabase Configuration

The app uses Supabase for:
- ✅ Authentication (email/password)
- ✅ Data storage (routines, runs, settings)
- ✅ Row-Level Security (each user sees only their data)

**Steps:**

1. Create a Supabase project at [supabase.com](https://supabase.com)
2. Open **SQL Editor** and run [`supabase/schema.sql`](supabase/schema.sql)
3. Copy your project URL and anon key from **Settings → API**
4. Update credentials in `js/app.js`:
   ```javascript
   const SUPABASE_URL = 'https://your-project.supabase.co';
   const SUPABASE_ANON_KEY = 'your-anon-key';
   ```

**⚠️ Important:** In Supabase dashboard → **Authentication → Sign In/Providers → Email**, turn **OFF** "Confirm email" for immediate account activation (or leave ON for email verification).

### 2️⃣ Netlify Deployment

**Option A: One-Click Deploy**

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start)

**Option B: Manual Setup**

1. Connect your GitHub repo to Netlify
2. Build settings are auto-detected from `netlify.toml`
3. Set environment variables (see below)

**Environment Variables:**

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_TRIGGER` | Yes* | Routine trigger ID (`trig_...`) or full `/fire` URL |
| `CLAUDE_TOKEN` | Yes* | Anthropic bearer token (or use `ANTHROPIC_API_KEY`) |
| `ROUTINER_FIRE_SECRET` | Recommended | Shared secret to lock the trigger endpoint |
| `ALLOWED_EMAILS` | Optional | Comma-separated whitelist of allowed emails |
| `CLAUDE_ROUTINE_BETA` | Optional | Override the `anthropic-beta` header |

<sub>*Can also be configured in-app under Settings</sub>

**Per-Account Overrides:**
```
CLAUDE_TRIGGER_ZPARXMARKETING=trig_abc123...
CLAUDE_TOKEN_ZPARXMARKETING=sk-ant-...
```

### 3️⃣ Security: Lock the Trigger Endpoint

By default, the trigger function is open. Secure it:

1. Set `ROUTINER_FIRE_SECRET` in Netlify environment variables (use a long random string)
2. Set the **same** secret in Supabase → Edge Functions → `routiner-scheduler` → Secrets
3. Optionally set `ALLOWED_EMAILS` to whitelist specific users

Once configured:
- Web app sends Supabase access token automatically
- Scheduler authenticates with shared secret
- Random users can't burn your tokens

---

## 🚀 Usage

### Running Routines

**Via Web UI:**
1. Sign in at your deployed URL
2. Click "+ New Routine"
3. Write your prompt
4. Choose: Run Now, Schedule, or Save to Library

**Via API:**
```bash
curl -X POST https://your-site.netlify.app/api/claude-trigger \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SUPABASE_TOKEN" \
  -d '{"text": "Your prompt here"}'
```

### Delegating Work to GLM

For cheap, high-volume sub-tasks, delegate to GLM:

```bash
# Simple coding task
node scripts/glm.mjs "Write a regex for E.164 phone numbers. Output only it."

# Harder task with GLM-5
node scripts/glm.mjs --model z-ai/glm-5 "<complex sub-task>"

# Health check
node scripts/glm.mjs --ping
```

**Model Selection:**
- `z-ai/glm-4.7` — Coding default (fast & cheap)
- `z-ai/glm-5` — Harder coding tasks
- `deepseek/deepseek-chat` — Cheapest all-rounder
- `meta-llama/llama-3.3-70b-instruct` — Longer structured output

> **Note:** GLM calls are proxied through Supabase Edge Functions (`dynamic-responder`) with server-side key management. Routine sessions don't need API keys.

---

## 📁 Project Structure

```
.
├── index.html              # Main app UI
├── usage.html              # Usage dashboard
├── js/
│   └── app.js              # Core application logic
├── css/                    # Stylesheets
├── netlify/
│   └── functions/
│       └── claude-trigger.mjs  # Serverless trigger function
├── scripts/
│   ├── glm.mjs             # GLM helper for work delegation
│   └── usage-meter.mjs     # Usage tracking
├── supabase/
│   ├── schema.sql          # Database schema + RLS policies
│   └── functions/
│       └── dynamic-responder/  # OpenRouter proxy
├── CLAUDE.md               # Agent delegation guide
└── README.md               # This file
```

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Development
1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

### Testing
- Test routines with the "Test Live" feature before scheduling
- Use `node scripts/glm.mjs --ping` to verify GLM proxy connectivity
- Check usage dashboard for token/cost tracking

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🆘 Support & Resources

- **Documentation:** See [`CLAUDE.md`](CLAUDE.md) for the full agent delegation playbook
- **Issues:** Report bugs via GitHub Issues
- **Live Demo:** [zroutiner.netlify.app](https://zroutiner.netlify.app)

---

## 🎯 Roadmap

- [ ] Calendar view for scheduled routines
- [ ] Team collaboration features
- [ ] Advanced scheduling (cron expressions)
- [ ] More AI model integrations
- [ ] Mobile app

---

<div align="center">

**Built with ❤️ using Claude + Supabase + Netlify**

[⬆ Back to Top](#claude-routine-planner)

</div>
