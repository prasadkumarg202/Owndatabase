import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight, BadgeIndianRupee, Bell, Boxes, Check, CheckCircle2, Clock, CloudUpload, Code2,
  Database, FileText, Gauge, HardDrive, KeyRound, Mail, MessageSquareText, Moon, Radio,
  Receipt, Rocket, ShieldCheck, Smartphone, Sparkles, Sprout, TrendingUp, Webhook, Zap,
} from 'lucide-react';

export const metadata: Metadata = {
  title: { absolute: 'AapStack | Backend for startups: database, OTP, SMS, email and APIs, hosted in India' },
  description:
    'AapStack gives startups a PostgreSQL database, phone OTP and SMS, email via Gmail or any SMTP, social logins, instant APIs, storage and realtime on servers in Mumbai. Free plan that never sleeps, GST invoices, pay with UPI.',
  robots: { index: true, follow: true },
};

/* ── Data ───────────────────────────────────────────────────────────────── */

const flow = [
  { icon: Smartphone, label: 'OTP sent to +91 98•••••210', via: 'MSG91 SMS', ms: '1.2 s' },
  { icon: KeyRound, label: 'Phone verified, session issued', via: 'AapStack Auth', ms: '18 ms' },
  { icon: Mail, label: 'Welcome email delivered', via: 'Gmail SMTP', ms: '0.9 s' },
  { icon: Database, label: 'POST /rest/v1/profiles  201', via: 'Instant API', ms: '31 ms' },
  { icon: Bell, label: 'New signup posted to #growth', via: 'Webhook → Slack', ms: '0.4 s' },
];

const stats = [
  { value: 'Mumbai', label: 'Servers in India, about 30 ms queries for Indian users' },
  { value: '50,000', label: 'Users included on the free plan' },
  { value: '14+', label: 'Social logins, plus SAML single sign-on' },
  { value: '0', label: 'Times your free project gets paused' },
];

const integrations = [
  { icon: Smartphone, title: 'SMS & WhatsApp OTP', tone: 'emerald', items: ['Twilio', 'MSG91', 'Gupshup', 'AWS SNS', 'WhatsApp'], body: 'Phone sign-in with one-time codes. Use the built-in Twilio connector or plug any provider in through a webhook.' },
  { icon: Mail, title: 'Email', tone: 'rose', items: ['Gmail', 'Zoho Mail', 'Resend', 'Any SMTP'], body: 'Verification, magic links, password resets and OTP emails sent through the mailbox you already have.' },
  { icon: KeyRound, title: 'Social logins', tone: 'blue', items: ['Google', 'Apple', 'Microsoft', 'GitHub', 'LinkedIn', 'Facebook', 'SAML SSO'], body: 'One-click sign-in with the accounts your users trust, and enterprise SSO when bigger customers ask for it.' },
  { icon: HardDrive, title: 'File storage', tone: 'amber', items: ['Amazon S3', 'Cloudflare R2', 'Backblaze', 'MinIO'], body: 'Keep uploads on the storage you choose, with public and private buckets, signed links and image resizing.' },
  { icon: Webhook, title: 'Webhooks & automation', tone: 'violet', items: ['Slack', 'Zapier', 'n8n', 'Your API'], body: 'Fire a webhook on any insert, update or delete, run cron jobs and queue background work without extra servers.' },
  { icon: Sparkles, title: 'AI ready', tone: 'cyan', items: ['pgvector', 'OpenAI', 'Hugging Face', 'MCP'], body: 'Store embeddings next to your data for search and recommendations, and let AI assistants manage projects over MCP.' },
];

const toneClasses: Record<string, string> = {
  emerald: 'bg-emerald-50 text-emerald-600',
  rose: 'bg-rose-50 text-rose-600',
  blue: 'bg-blue-50 text-blue-600',
  amber: 'bg-amber-50 text-amber-600',
  violet: 'bg-violet-50 text-violet-600',
  cyan: 'bg-cyan-50 text-cyan-600',
};

const journey = [
  { icon: Sprout, stage: 'Idea', title: 'Prototype for free', items: ['PostgreSQL database with SQL editor', 'Email and Google login', 'Instant REST and GraphQL APIs'] },
  { icon: Rocket, stage: 'Launch', title: 'Go live with real users', items: ['Phone OTP over SMS or WhatsApp', 'File uploads and image resizing', 'Row Level Security on every request'] },
  { icon: TrendingUp, stage: 'Traction', title: 'Automate and engage', items: ['Realtime updates and presence', 'Cron jobs, queues and functions', 'Webhooks into Slack, n8n or your CRM'] },
  { icon: Gauge, stage: 'Scale', title: 'Stay fast and safe', items: ['Verified backups and point-in-time restore', 'High-availability PostgreSQL with failover', 'Usage, logs and alerts in one dashboard'] },
];

const savings = [
  { icon: Moon, title: 'A free plan that never sleeps', body: 'Free projects stay online even when traffic is quiet, so your demo works when the investor clicks the link.' },
  { icon: MessageSquareText, title: 'No markup on SMS and email', body: 'Connect your own MSG91, Twilio or Gmail account and pay them directly at their rates.' },
  { icon: Receipt, title: 'GST-ready invoices', body: 'Tax invoices with your GSTIN and the CGST, SGST and IGST breakdown, ready for input tax credit.' },
  { icon: BadgeIndianRupee, title: 'Pay the Indian way', body: 'UPI, cards and netbanking through Razorpay payment links. No international card needed.' },
  { icon: ShieldCheck, title: 'Never locked in', body: 'It is standard PostgreSQL. Export everything with pg_dump whenever you want and take it anywhere.' },
  { icon: Zap, title: 'One bill, not ten tools', body: 'Database, auth, storage, realtime, functions and backups in one place instead of separate subscriptions.' },
];

const builtins = [
  { icon: Database, label: 'PostgreSQL' }, { icon: KeyRound, label: 'Auth & MFA' }, { icon: Code2, label: 'REST & GraphQL' },
  { icon: CloudUpload, label: 'Storage' }, { icon: Radio, label: 'Realtime' }, { icon: Boxes, label: 'Functions' },
  { icon: Clock, label: 'Cron & queues' }, { icon: FileText, label: 'Backups & PITR' },
];

/* ── Page ───────────────────────────────────────────────────────────────── */

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white text-slate-900 antialiased">
      {/* Nav */}
      <header className="absolute inset-x-0 top-0 z-30">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-cyan-400 shadow-lg shadow-blue-500/30"><Database className="h-4 w-4 text-white" /></span>
            <span className="text-lg font-semibold tracking-tight text-white">AapStack</span>
          </Link>
          <nav className="hidden items-center gap-7 text-sm text-slate-300 md:flex">
            <a href="#integrations" className="hover:text-white">Integrations</a>
            <a href="#journey" className="hover:text-white">For startups</a>
            <a href="#pricing" className="hover:text-white">Pricing</a>
            <a href="/api/docs" className="hover:text-white">Docs</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/login" className="px-3 py-2 text-sm text-slate-200 hover:text-white">Sign in</Link>
            <Link href="/login?mode=signup" className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-blue-50">Start free</Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden bg-slate-950 pb-20 pt-32 text-white sm:pt-36">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[32rem] w-[32rem] rounded-full bg-blue-600/30 blur-3xl" aria-hidden="true" />
        <div className="pointer-events-none absolute -right-32 top-20 h-[28rem] w-[28rem] rounded-full bg-cyan-500/20 blur-3xl" aria-hidden="true" />
        <div className="relative mx-auto grid max-w-6xl gap-14 px-4 lg:grid-cols-[1.1fr_1fr] lg:items-center">
          <div className="min-w-0">
            <p className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-slate-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Built for Indian startups · Hosted in Mumbai
            </p>
            <h1 className="mt-6 text-4xl font-bold leading-[1.08] tracking-tight sm:text-6xl">
              Your startup&apos;s backend,{' '}
              <span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">ready before lunch.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-300">
              Database, phone OTP over SMS and WhatsApp, email through Gmail, social logins, instant APIs and file storage,
              already connected to each other. Spend your runway on customers, not on wiring up services.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/login?mode=signup" className="inline-flex items-center gap-2 rounded-full bg-blue-500 px-6 py-3 font-semibold text-white shadow-lg shadow-blue-500/30 hover:bg-blue-400">
                Start free, no card needed <ArrowRight className="h-4 w-4" />
              </Link>
              <a href="#integrations" className="rounded-full border border-white/20 px-6 py-3 font-semibold text-white hover:border-white/40">
                See integrations
              </a>
            </div>
          </div>

          {/* Live signup flow */}
          <div className="relative min-w-0">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-2xl backdrop-blur">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">One signup, five integrations</p>
                <span className="flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> live
                </span>
              </div>
              <ol className="mt-4 space-y-2.5">
                {flow.map(({ icon: Icon, label, via, ms }, i) => (
                  <li key={label} className="flex items-center gap-3 rounded-xl border border-white/10 bg-slate-900/60 px-3.5 py-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 text-blue-300"><Icon className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-slate-100">{label}</p>
                      <p className="text-[11px] text-slate-400">{i + 1}. via {via}</p>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-slate-500">{ms}</span>
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="relative mx-auto mt-16 max-w-6xl px-4">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 md:grid-cols-4">
            {stats.map((s) => (
              <div key={s.label} className="bg-slate-950 p-5">
                <p className="text-2xl font-bold">{s.value}</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Integrations */}
      <section id="integrations" className="mx-auto max-w-6xl scroll-mt-8 px-4 py-24">
        <p className="text-sm font-semibold uppercase tracking-wider text-blue-600">Integrations</p>
        <h2 className="mt-2 max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">Plug in the services your users already use</h2>
        <p className="mt-4 max-w-2xl text-slate-600">
          Most backends stop at the database. AapStack connects the messy parts too: SMS gateways, email, social logins and the tools your team works in.
        </p>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {integrations.map(({ icon: Icon, title, tone, items, body }) => (
            <div key={title} className="flex flex-col rounded-2xl border border-slate-200 p-6 transition hover:-translate-y-0.5 hover:shadow-lg">
              <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${toneClasses[tone]}`}><Icon className="h-5 w-5" /></span>
              <h3 className="mt-4 text-lg font-semibold">{title}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-slate-600">{body}</p>
              <div className="mt-5 flex flex-wrap gap-1.5">
                {items.map((it) => <span key={it} className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700">{it}</span>)}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Journey */}
      <section id="journey" className="scroll-mt-8 bg-slate-50 py-24">
        <div className="mx-auto max-w-6xl px-4">
          <p className="text-sm font-semibold uppercase tracking-wider text-blue-600">For startups</p>
          <h2 className="mt-2 max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">One backend from first idea to first million users</h2>
          <div className="relative mt-14 grid gap-10 md:grid-cols-4 md:gap-6">
            <div className="absolute left-0 right-0 top-6 hidden h-px bg-gradient-to-r from-blue-200 via-cyan-300 to-blue-200 md:block" aria-hidden="true" />
            {journey.map(({ icon: Icon, stage, title, items }) => (
              <div key={stage} className="relative">
                <span className="relative flex h-12 w-12 items-center justify-center rounded-full border-4 border-slate-50 bg-blue-600 text-white"><Icon className="h-5 w-5" /></span>
                <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-slate-500">{stage}</p>
                <h3 className="mt-1 font-semibold">{title}</h3>
                <ul className="mt-3 space-y-2">
                  {items.map((it) => <li key={it} className="flex gap-2 text-sm text-slate-600"><Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" /> {it}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Savings */}
      <section className="mx-auto max-w-6xl px-4 py-24">
        <p className="text-sm font-semibold uppercase tracking-wider text-blue-600">Lower cost</p>
        <h2 className="mt-2 max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">Spend on growth, not on infrastructure</h2>
        <div className="mt-12 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {savings.map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><Icon className="h-5 w-5" /></span>
              <div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="scroll-mt-8 border-y border-slate-200 bg-slate-50 py-24">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">Start free. Upgrade when you have traction.</h2>
          <div className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-8">
              <p className="font-semibold">Free</p>
              <p className="mt-2 text-4xl font-bold">$0<span className="text-base font-normal text-slate-500"> / month</span></p>
              <p className="mt-2 text-sm text-slate-500">For prototypes, hackathons and your first users.</p>
              <ul className="mt-6 space-y-2.5 text-sm text-slate-700">
                {['2 projects that never pause', '50,000 users per project', '500 MB database, 1 GB file storage', '50,000 API requests a day', '200 realtime connections'].map((t) => (
                  <li key={t} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" /> {t}</li>
                ))}
              </ul>
              <Link href="/login?mode=signup" className="mt-8 block rounded-full border border-slate-300 py-3 text-center font-semibold hover:border-slate-400">Start free</Link>
            </div>
            <div className="relative rounded-2xl border-2 border-blue-500 bg-white p-8 shadow-xl shadow-blue-500/10">
              <span className="absolute -top-3 right-6 rounded-full bg-blue-600 px-3 py-1 text-xs font-semibold text-white">For growing startups</span>
              <p className="font-semibold">Pro</p>
              <p className="mt-2 text-4xl font-bold">$25<span className="text-base font-normal text-slate-500"> / month</span></p>
              <p className="mt-2 text-sm text-slate-500">Billed with a GST invoice. Pay by UPI, card or netbanking.</p>
              <ul className="mt-6 space-y-2.5 text-sm text-slate-700">
                {['10 projects', '8 GB database, 100 GB file storage', '5 million API requests a month', '2 million function calls a month', '1,000 realtime connections'].map((t) => (
                  <li key={t} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" /> {t}</li>
                ))}
              </ul>
              <Link href="/login?mode=signup" className="mt-8 block rounded-full bg-blue-600 py-3 text-center font-semibold text-white hover:bg-blue-500">Get started</Link>
            </div>
          </div>
          <p className="mt-6 text-center text-sm text-slate-500">Need more? The Team plan has unlimited projects and higher limits.</p>
        </div>
      </section>

      {/* Developers */}
      <section className="mx-auto max-w-6xl px-4 py-24">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div className="min-w-0">
            <p className="text-sm font-semibold uppercase tracking-wider text-blue-600">For developers</p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Phone login in a few lines of code</h2>
            <p className="mt-4 text-slate-600">
              Use the supabase-js client you already know, or call the REST and GraphQL APIs from any language.
              Coming from Supabase? Point your app at AapStack and import your existing data.
            </p>
            <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {builtins.map(({ icon: Icon, label }) => (
                <div key={label} className="flex flex-col items-center gap-2 rounded-xl border border-slate-200 p-3 text-center">
                  <Icon className="h-5 w-5 text-blue-600" />
                  <span className="text-xs font-medium text-slate-700">{label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="min-w-0 overflow-hidden rounded-2xl bg-slate-950 shadow-2xl">
            <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-3">
              <span className="h-3 w-3 rounded-full bg-rose-400/80" /><span className="h-3 w-3 rounded-full bg-amber-400/80" /><span className="h-3 w-3 rounded-full bg-emerald-400/80" />
              <span className="ml-2 text-xs text-slate-500">login.ts</span>
            </div>
            <pre className="overflow-x-auto p-6 text-[13px] leading-relaxed text-slate-300"><code>{`import { createClient } from '@supabase/supabase-js'
const app = createClient('https://aapstack.tech/p/<project-id>', '<anon-key>')

// 1. Send an OTP by SMS
await app.auth.signInWithOtp({ phone: '+919876543210' })

// 2. Verify the code the user typed
await app.auth.verifyOtp({ phone: '+919876543210', token: '482913', type: 'sms' })

// 3. Read their data, protected by Row Level Security
const { data } = await app.from('orders').select('*')`}</code></pre>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-4 pb-24">
        <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl bg-gradient-to-br from-blue-600 to-cyan-500 px-6 py-14 text-center text-white sm:px-12">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Build your MVP this weekend</h2>
          <p className="mx-auto mt-3 max-w-xl text-blue-50">Create a free project, connect your SMS and email providers, and ship your first feature today.</p>
          <Link href="/login?mode=signup" className="mt-8 inline-flex items-center gap-2 rounded-full bg-white px-7 py-3 font-semibold text-blue-700 hover:bg-blue-50">
            Create your free project <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <footer className="border-t border-slate-200">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2"><Database className="h-4 w-4 text-blue-600" /> AapStack · Backend platform for startups · Mumbai, India</span>
          <span className="flex gap-5">
            <Link href="/login" className="hover:text-slate-900">Sign in</Link>
            <Link href="/dashboard" className="hover:text-slate-900">Dashboard</Link>
            <a href="/api/docs" className="hover:text-slate-900">API docs</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
