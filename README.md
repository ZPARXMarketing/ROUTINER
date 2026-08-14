# 🔄 Claude Routine Planner

[![Netlify Status](https://api.netlify.com/api/v1/badges/your-badge-id/deploy-status)](https://zroutiner.netlify.app)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Supabase](https://img.shields.io/badge/Supabase-Backend-green)](https://supabase.com)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Integrated-orange)](https://claude.ai/code)

A powerful Claude Code routine planner and scheduler with multi-agent orchestration, built on the [ZPARX design system](https://github.com/zparxmarketing/zparxbrand-design).

**[🚀 Live Demo](https://zroutiner.netlify.app)** | **[📖 Documentation](CLAUDE.md)** | **[🐛 Report Bug](../../issues)** | **[✨ Request Feature](../../issues)**

---

## 📑 Table of Contents

- [What is Routiner?](#-what-is-routiner)
- [Quick Start](#-quick-start)
- [Features](#-features)
- [Architecture](#-architecture)
- [Setup Guide](#-setup-guide)
  - [1. Supabase Setup](#1-supabase-storage--login)
  - [2. Netlify Setup](#2-netlify-hosting--trigger)
  - [3. Authentication Lock](#3-locking-the-trigger-optional--recommended)
- [Agent Delegation System](#-agents-that-delegate-their-own-work)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🔒 Before You Fork or Publish

This repo ships **no secrets** — API keys and tokens all live in Supabase edge
secrets / Netlify env vars, never in code. The Supabase URL and publishable
(anon) key in [`js/config.js`](js/config.js) are *meant* to be public (RLS
protects every row per-user) — that part is safe as-is.

The one thing that **is** on you before going public: the OpenRouter proxy
(`supabase/functions/dynamic-responder`) is deployed with `verify_jwt=false`
and, unless you set `RESPONDER_SECRET`, it is **world-callable** — anyone who
finds your Supabase URL (trivially visible in this repo) can invoke it and
spend against your OpenRouter key. Two edge secrets close that:

| Secret | What it does |
|--------|---------------|
| `RESPONDER_SECRET` | Requires callers to present a shared secret (`Authorization: Bearer <secret>` or `x-responder-secret`). Without it, the proxy is open. |
| `MAX_DAILY_SPEND` | Hard USD cap per UTC day, enforced server-side even if the secret leaks. |

Set both in **Supabase → Project Settings → Edge Functions → Secrets** before
you make the repo public. (`openrouter-agent`, the code-writing agent, is
already gated — it refuses unauthenticated callers by default.) See
[`CLAUDE.md`](CLAUDE.md) for the full hardening list (`ALLOWED_MODELS`,
`GITHUB_ALLOWED_REPOS`, `AGENT_ALLOW_MERGE`, etc.).

---

## 🎯 What is Routiner?

Routiner is a **swarm-based task orchestration platform** that schedules and executes Claude Code routines across multiple accounts simultaneously. 

**Key Benefits:**
- 🔄 **Parallel Execution** — Fire multiple Claude sessions simultaneously
- ⏰ **Smart Scheduling** — Queue tasks for specific times with repeat options
- 🤖 **Agent Delegation** — Orchestrator agents delegate grunt work to cheaper models
- 📊 **Usage Tracking** — Real-time dashboard showing token usage and costs
- 🔐 **Secure by Default** — Row-level security per user, server-side token management

---

## 🚀 Quick Start

**Already have a Supabase account?** Get started in 3 minutes:

1. **Fork this repo** and connect to Netlify
2. **Create a Supabase project** and run [`supabase/schema.sql`](supabase/schema.sql)
3. **Add your Claude trigger + token** in the app settings

That's it! Sign in and start creating routines.

**New to Supabase?** See the detailed [Setup Guide](#-setup-guide) below.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| **▶ Run Now** | Fire your Claude routine immediately with a custom prompt |
| **⏰ Schedule** | Queue prompts for specific dates/times with daily/weekly repeat options |
| **▣ Library** | Save prompts to iterate on later before scheduling |
| **⧉ Manage** | Copy, archive, restore, and delete prompts across states |
| **⚡ Test Live** | Instant preview via Messages API (requires Anthropic key) |
| **📊 Usage Dashboard** | Track tokens, costs, and delegation efficiency |

---

## 🏗 Architecture

```
┌─────────────┐                     ┌──────────────────────────────┐
│             │  auth + CRUD        │                              │
│  Planner UI ├────────────────────►│  Supabase (RLS per user)     │
│             │                     │  • routiner_routines         │
│             │                     │  • routiner_runs              │
│             │                     │  • routiner_settings          │
└──────┬──────┘                     └──────────────────────────────┘
       │
       │ Run Now
       │
       ▼
┌─────────────────────────────────────┐
│  Netlify Function                   │
│  .netlify/functions/claude-trigger  │
└──────────┬──────────────────────────┘
           │
           ▼
    ┌─────────────┐
    │ Claude Code │
    │  Routine    │
    └─────────────┘
```

---

## 📦 Setup Guide

### 1. Supabase (Storage + Login)

The app uses the `zparx-dashboard` Supabase project with row-level security (RLS) ensuring each account only sees its own data.

#### For This Project
Already configured! Just sign in and use.

#### For Your Own Fork

1. **Create a Supabase project** at [supabase.com](https://supabase.com)

2. **Run the schema:** Open SQL Editor and paste [`supabase/schema.sql`](supabase/schema.sql)
   
   This creates:
   - `routiner_routines` table
   - `routiner_runs` table  
   - `routiner_settings` table
   - RLS policies for user isolation

3. **Update configuration:** Replace the Supabase URL and publishable key in:
   - [`js/app.js`](js/app.js)
   - [`netlify/functions/claude-trigger.mjs`](netlify/functions/claude-trigger.mjs)

4. **Enable email login:** In Supabase Dashboard → Authentication → Sign In/Providers → Email
   
   Turn **OFF** "Confirm email" for immediate account access
   
   *(Or leave ON if you prefer email confirmation before first login)*

---

### 2. Netlify (Hosting + Trigger)

**Live at:** https://zroutiner.netlify.app (auto-deploys from `main`)

**Supabase edge functions** also auto-deploy from `main` when
`supabase/functions/**` changes (GitHub Action *Deploy Edge Functions*). Add
repo secret `SUPABASE_ACCESS_TOKEN` (and optional `SUPABASE_PROJECT_ID`) once —
see CLAUDE.md.

#### Option A: In-App Configuration (Easiest)

1. Sign in to the app
2. Open **⚙ Settings**
3. Paste your Claude **trigger ID** + **token** for each account
4. Done! Settings save to your Supabase row (RLS-protected)

#### Option B: Environment Variables (Server-Side)

Set in **Netlify → Site settings → Environment variables**:

| Variable | Value | Required |
|----------|-------|----------|
| `CLAUDE_TRIGGER` | Routine trigger ID (`trig_...`) or full `/fire` URL | ✅ |
| `CLAUDE_TOKEN` | Anthropic bearer token (or use `ANTHROPIC_API_KEY`) | ✅ |
| `CLAUDE_TRIGGER_<ACCOUNT>` | Per-account trigger override (e.g., `CLAUDE_TRIGGER_ZPARX`) | 🔸 |
| `CLAUDE_TOKEN_<ACCOUNT>` | Per-account token override | 🔸 |
| `CLAUDE_ROUTINE_BETA` | Override `anthropic-beta` header | 🔸 |

✅ Required | 🔸 Optional

**How it works:**

```bash
POST https://api.anthropic.com/v1/claude_code/routines/<trigger-id>/fire
  Authorization: Bearer <CLAUDE_TOKEN>
  anthropic-version: 2023-06-01
  anthropic-beta: experimental-cc-routine-2026-04-01
  
  { "text": "<the routine's prompt>" }
```

---

### 3. Locking the Trigger (Optional + Recommended)

By default, the trigger function is open. **Secure it** to prevent unauthorized use:

#### Step 1: Set the shared secret

| Location | Variable | Value |
|----------|----------|-------|
| Netlify env vars | `ROUTINER_FIRE_SECRET` | Any long random string |
| Supabase Edge Functions → `routiner-scheduler` secrets | `ROUTINER_FIRE_SECRET` | **Same string** |

#### Step 2: (Optional) Whitelist emails

Set `ALLOWED_EMAILS` in Netlify env vars (comma-separated list):

```
ALLOWED_EMAILS=user1@example.com,user2@example.com
```

**Result:**
- ✅ Web app requires valid Supabase access token (automatic when signed in)
- ✅ Scheduler authenticates with shared secret
- ✅ Only whitelisted emails can fire (if configured)

---

## 🤖 Agents That Delegate Their Own Work

Routiner isn't one assistant — it's a **coordinated swarm of scheduled Claude agents**.

### How It Works

| Concept | Description |
|---------|-------------|
| **Parallel Routines** | Multiple triggers (A/B/C…) fire as independent, simultaneous sessions |
| **Decomposition** | Big tasks split into ordered blocks across the right time horizon |
| **Smart Delegation** | Orchestrator keeps judgment calls, delegates grunt work to GLM (cheaper model) |
| **Cost Visibility** | Live dashboard tracks every delegated call with token + dollar cost |

### Delegation Flow

```
┌─────────────┐
│   Claude    │  ← Handles strategy, judgment, review
│ Orchestrator│
└──────┬──────┘
       │
       │ delegates grunt work
       ▼
┌─────────────┐
│  GLM Model  │  ← Faster, cheaper for boilerplate, drafts, coding sub-tasks
│(via OpenRouter)│
└─────────────┘
```

**Example usage:**

```bash
# Delegate a specific task
node scripts/glm.mjs "Write a regex for E.164 phone numbers. Output only it."

# Health check
node scripts/glm.mjs --ping
```

The OpenRouter path runs through a Supabase edge proxy (`dynamic-responder`) that holds the API key server-side, so sessions never need their own keys.

📚 **See [`CLAUDE.md`](CLAUDE.md) for the full delegation playbook.**

---

## 📊 Usage Tracking

Every delegated call is logged with cost metrics:

- **Live Dashboard:** `usage.html` / `scripts/usage-meter.mjs`
- **Metrics:** Tokens used, dollar cost, call frequency
- **Purpose:** Understand exactly what your agents did and what it cost

---

## 🤝 Contributing

Contributions are welcome! Here's how to help:

1. **Fork the repository**
2. **Create a feature branch** (`git checkout -b feature/amazing-feature`)
3. **Commit your changes** (`git commit -m 'Add amazing feature'`)
4. **Push to the branch** (`git push origin feature/amazing-feature`)
5. **Open a Pull Request**

### Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/zroutiner.git
cd zroutiner

# Install dependencies (if any)
npm install

# Run locally
# Open index.html in browser, or use a local server
npx serve .
```

### Code Style

- Keep functions small and focused
- Add comments for complex logic
- Test across different screen sizes
- Ensure RLS policies work correctly

---

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- Built with [Claude Code](https://claude.ai/code) routine integration
- Powered by [Supabase](https://supabase.com) for backend
- Hosted on [Netlify](https://netlify.com) with serverless functions
- Design system by [ZPARX](https://github.com/zparxmarketing/zparxbrand-design)

---

<div align="center">

**Made with ❤️ by the ZPARX team**

[⬆ Back to Top](#-claude-routine-planner)

</div>