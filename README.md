# Claude Routine Planner

[![Status](https://img.shields.io/badge/Status-Active-brightgreen)](https://zroutiner.netlify.app)
[![License](https://img.shields.io/badge/License-MIT-blue)](#license)
[![Built with](https://img.shields.io/badge/Built%20with-Supabase%20%7C%20Netlify%20%7C%20Claude-orange)](#tech-stack)

> **A Claude Code routine planner and scheduler** — Write prompts, schedule them, and let Claude agents execute them automatically.

**Live Demo:** [zroutiner.netlify.app](https://zroutiner.netlify.app)

Built on the [ZPARX design system](https://github.com/zparxmarketing/zparxbrand-design).

---

## 🚀 Quick Start

Get started in 3 steps:

### 1. Sign In
Create an account or sign in with email/password. No email confirmation required.

### 2. Add Your Claude Credentials
Open **⚙ Settings** and paste your:
- **Claude Trigger ID** (`trig_...`)
- **Claude Token** (your Anthropic API key)

These are saved securely in your account (row-level secured in Supabase).

### 3. Create Your First Routine
- Click **New Routine**
- Write your prompt
- Choose: **Run now**, **Schedule**, or **Save to library**

That's it! Your Claude agent will execute on schedule.

---

## ✨ Features

| Feature | What it does |
|---------|-------------|
| **▶ Run Now** | Fires your Claude routine immediately |
| **⏰ Schedule** | Queue prompts for specific times (daily/weekdays/weekly) |
| **▣ Save to Library** | Store prompts for later iteration |
| **⧉ Manage** | Copy, archive, restore, and delete routines |
| **⚡ Test Live** | Optional instant preview via Messages API |

---

## 🤖 Agent Swarm Architecture

Routiner isn't one assistant — it's a **swarm of scheduled Claude agents** that work in parallel.

### Key Capabilities

- **🔄 Parallel Execution** — Multiple triggers (A/B/C...) fire as independent sessions
- **📊 Smart Decomposition** — Break large projects into ordered, scheduled blocks
- **⚡ Cheap Work Offload** — Delegate grunt work to faster models (GLM via OpenRouter)
- **📈 Usage Dashboard** — Track every delegated call with token and cost metrics

### How It Works

```
┌─────────────┐
│  Planner UI │
└──────┬──────┘
       │
       ├── auth + CRUD ──► Supabase (routiner_routines / routiner_runs)
       │
       └── Run now ──► Netlify Function ──► Claude Code routine /fire
```

---

## 🛠️ Setup Guide

### Prerequisites

- Supabase account (free tier works)
- Netlify account (free tier works)
- Anthropic API key

### 1. Supabase (Database + Auth)

The app uses the `zparx-dashboard` Supabase project with row-level security (RLS) enabled.

**Forking this project?**

1. Create a new Supabase project
2. Open **SQL Editor** and run [`supabase/schema.sql`](supabase/schema.sql)
3. Update `js/app.js` and `netlify/functions/claude-trigger.mjs` with your project URL and key

**Enable email login:**

Go to **Authentication → Sign In / Providers → Email** and turn **off** "Confirm email" for instant access.

### 2. Netlify (Hosting + Functions)

Hosted at **https://zroutiner.netlify.app** with auto-deploy from `main`.

**Deploy your own:**

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start)

**Configure environment variables:**

| Variable | Description |
|----------|-------------|
| `CLAUDE_TRIGGER` | Routine trigger ID (`trig_...`) or full `/fire` URL |
| `CLAUDE_TOKEN` | Your Anthropic bearer token |
| `CLAUDE_TRIGGER_<ACCOUNT>` | *(optional)* Per-account trigger override |
| `CLAUDE_TOKEN_<ACCOUNT>` | *(optional)* Per-account token override |
| `ROUTINER_FIRE_SECRET` | *(recommended)* Shared secret to lock the trigger |
| `ALLOWED_EMAILS` | *(optional)* Comma-separated whitelist of allowed emails |

### 3. Security (Recommended)

Lock your trigger to require authentication:

1. Set `ROUTINER_FIRE_SECRET` in Netlify environment variables
2. Set the same value in Supabase Edge Functions → `routiner-scheduler` secrets
3. *(Optional)* Set `ALLOWED_EMAILS` to restrict who can fire

Once configured:
- Browser requests need a valid Supabase access token (automatic when signed in)
- Scheduler requests authenticate with the shared secret

---

## 💡 Offloading Work to Cheaper Models

For high-volume, low-stakes tasks, delegate to **GLM via OpenRouter** to save cost and time.

### Good Candidates for Offloading
- ✅ Bulk drafting and reformatting
- ✅ First-pass summaries
- ✅ Boilerplate generation
- ✅ Simple coding sub-tasks (regex, unit tests, small functions)

### Never Offload
- ❌ Final judgment calls
- ❌ Security-sensitive logic
- ❌ Work that ships without your review

### Usage Example

```bash
# One-line helper (preferred)
node scripts/glm.mjs "Write a regex for E.164 phone numbers. Output only it."

# Health check
node scripts/glm.mjs --ping

# Harder tasks
node scripts/glm.mjs --model z-ai/glm-5 "<complex sub-task>"
```

See [`CLAUDE.md`](CLAUDE.md) for the complete delegation playbook.

---

## 📁 Project Structure

```
├── index.html              # Main app
├── js/app.js              # Application logic
├── css/                   # Styles
├── netlify/functions/     # Serverless functions
├── supabase/              # Database schema & migrations
├── scripts/               # Helper scripts (GLM, usage meter)
└── routines/              # (legacy, not used)
```

---

## 🎨 Screenshots

> *Screenshots coming soon*

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🔗 Links

- [Live App](https://zroutiner.netlify.app)
- [ZPARX Design System](https://github.com/zparxmarketing/zparxbrand-design)
- [Supabase](https://supabase.com)
- [Netlify](https://netlify.com)
- [Anthropic](https://anthropic.com)

---

## 📧 Support

For questions or issues, please [open an issue](https://github.com/zparxmarketing/zroutiner/issues) on GitHub.