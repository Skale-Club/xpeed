# 🚗 Xpeed

> AI-powered automotive analysis system for vehicle profile management and personalized insights.

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://reactjs.org/)
[![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev/)
[![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com/)
[![TailwindCSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)

## 📋 About

Xpeed is a modern web platform that uses artificial intelligence to provide detailed vehicle analysis. The system allows users to create personalized car profiles, perform intelligent queries, and obtain valuable insights about maintenance, performance, and technical specifications.

### ✨ Key Features

- 🤖 **Integrated AI Chat** - Converse with AI about your vehicle using Google Gemini
- 📊 **Profile Management** - Create and manage multiple vehicle profiles
- 🔐 **Secure Authentication** - Login with email/password or Google OAuth
- 📱 **Responsive Interface** - Modern design adaptable to all devices
- 💾 **Session History** - Save and continue previous conversations
- 🎨 **Modern UI/UX** - Interface built with shadcn/ui and Tailwind CSS

## 🚀 Tech Stack

### Frontend
- **React 18** - JavaScript library for user interfaces
- **TypeScript** - Typed superset of JavaScript
- **Vite** - Ultra-fast build tool
- **TanStack Query** - Asynchronous state management
- **React Router** - Client-side routing
- **Tailwind CSS** - Utility-first CSS framework
- **shadcn/ui** - Reusable UI components

### Backend & Services
- **Supabase** - Backend-as-a-Service (BaaS)
  - PostgreSQL Database
  - Authentication
  - Row Level Security (RLS)
- **Google Gemini AI** - AI model for chat functionality

### Development Tools
- **ESLint** - JavaScript/TypeScript linter
- **PostCSS** - CSS processor
- **dotenv** - Environment variable management

## 📦 Installation

### Prerequisites

- Node.js 18+
- npm or yarn
- Supabase account
- Google Gemini API key (optional)

### Setup

1. **Clone the repository**
```bash
git clone https://github.com/Skale-Club/xpeed.git
cd xpeed
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure environment variables**
```bash
cp .env.example .env
```

4. **Edit the `.env` file with your credentials**
```env
VITE_SUPABASE_PROJECT_ID=your_project_id_here
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your_publishable_key_here
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
```

5. **Start the development server**
```bash
npm run dev
```

The application will be available at `http://localhost:8080`

## 🗄️ Database Structure

### Main Tables

- **`car_profiles`** - User vehicle profiles
- **`chat_sessions`** - AI chat sessions
- **`chat_messages`** - Individual conversation messages
- **`app_settings`** - Application settings (API keys, etc)

## 🔧 Available Scripts

```bash
# Development
npm run dev              # Start development server

# Build
npm run build            # Compile for production
npm run preview          # Preview production build

# Linting
npm run lint             # Run ESLint

# Ops
npm run supabase:keepalive  # Update keepalive timestamp in Supabase
```

## Supabase Keepalive (operational note)

Supabase free-tier projects are auto-paused after 7 days of inactivity. This
repo has **two** GitHub Actions workflows that keep the project active and
detect failure:

- **`.github/workflows/supabase-keepalive.yml`** — every 6h, writes a heartbeat
  row to `app_settings.system.supabase_keepalive`, queries the `sessions`
  table, then commits a small heartbeat file to `.github/keepalive-heartbeat`
  and pushes. The push is what keeps the **repo** active — GitHub disables
  scheduled workflows after 60 days of no commits to the default branch, which
  is how we got paused the first time.
- **`.github/workflows/supabase-keepalive-healthcheck.yml`** — daily at 14:00
  UTC, reads back the heartbeat row and fails loudly if it is more than 12h
  stale. GitHub's built-in failed-workflow email is the alert channel.

Required GitHub repository secrets:

- `VITE_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Required repo setting: **Settings → Actions → General → Workflow permissions**
must be set to **"Read and write permissions"** so the heartbeat push works.

### Manual ops

```bash
# Run the keepalive against Supabase (locally, with .env loaded)
npm run supabase:keepalive

# Verify the heartbeat row is fresh
npm run supabase:keepalive:verify
```

### Recovery: project got paused / keepalive stopped working

If the Supabase pause email arrives again, work through these steps:

```bash
# 1. List workflows and check state — look for "disabled_inactivity"
gh api repos/Skale-Club/xpeed/actions/workflows

# 2. Re-enable if disabled (use the workflow id from step 1)
gh api repos/Skale-Club/xpeed/actions/workflows/<id>/enable -X PUT

# 3. Verify both required secrets still exist
gh secret list --repo Skale-Club/xpeed

# 4. Dispatch both workflows manually to confirm they work
gh workflow run "Supabase Keepalive"             --repo Skale-Club/xpeed --ref main
gh workflow run "Supabase Keepalive Health Check" --repo Skale-Club/xpeed --ref main

# 5. Tail the most recent run
gh run list --workflow="Supabase Keepalive" --repo Skale-Club/xpeed --limit 3

# 6. Unpause the Supabase project itself (manual, via dashboard):
#    https://supabase.com/dashboard/project/drqmrddxlrlbqnydumjm
```

If the heartbeat **commit-push** specifically is failing (script ran fine but
no commit appeared), check the workflow permissions setting above.

## 🔐 Security

### Implemented Best Practices

- ✅ Protected environment variables (`.env` in `.gitignore`)
- ✅ No hardcoded credentials in code
- ✅ Row Level Security (RLS) on Supabase
- ✅ Authentication via Supabase Auth
- ✅ Service Role Key only in Node.js scripts
- ✅ Validation of required environment variables

### ⚠️ IMPORTANT

- **NEVER** commit the `.env` file
- **ALWAYS** use `.env.example` as a template
- **NEVER** expose `SUPABASE_SERVICE_ROLE_KEY` on the client-side
- **ALWAYS** regenerate keys if accidentally exposed

## 🤝 Contributing

Contributions are welcome! Feel free to:

1. Fork the project
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License. See the `LICENSE` file for details.

## 🔗 Useful Links

- [Supabase Documentation](https://supabase.com/docs)
- [React Documentation](https://react.dev/)
- [Vite Documentation](https://vitejs.dev/)
- [Google Gemini AI](https://ai.google.dev/)
- [shadcn/ui](https://ui.shadcn.com/)

## 👨‍💻 Author

Built with ❤️ by Skale Club team

---

<p align="center">
  <strong>Xpeed</strong> - Artificial intelligence at the service of your vehicle
</p>
