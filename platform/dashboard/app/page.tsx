import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight, Check, Code2, Database, FileText, Film, HardDrive, Image as ImageIcon,
  KeyRound, MousePointer2, Radio, Sparkles, Webhook,
} from 'lucide-react';

export const metadata: Metadata = {
  title: { absolute: 'AapStack | The PostgreSQL development platform, hosted in India' },
  description:
    'Start your project with a PostgreSQL database. Add authentication, instant APIs, functions, realtime, storage and vector embeddings. Supabase-compatible, hosted in Mumbai.',
  robots: { index: true, follow: true },
};

/* ── Card shell ─────────────────────────────────────────────────────────── */

function Card({ icon: Icon, title, children, art, className = '' }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
  art?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`group relative flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white transition hover:border-slate-300 hover:shadow-sm ${className}`}>
      <div className="relative z-10 p-6">
        <div className="flex items-center gap-2 text-slate-900">
          <Icon className="h-4 w-4" />
          <h3 className="text-sm font-medium">{title}</h3>
        </div>
        <div className="mt-3 text-sm leading-relaxed text-slate-500">{children}</div>
      </div>
      {art && <div className="relative mt-auto" aria-hidden="true">{art}</div>}
    </div>
  );
}

const hl = 'text-slate-900';

/* ── Card illustrations (decorative) ────────────────────────────────────── */

function DatabaseArt() {
  return (
    <div className="pointer-events-none absolute -bottom-6 -right-6 hidden h-56 w-56 items-center justify-center rounded-[2.5rem] border border-slate-200 bg-gradient-to-br from-slate-50 to-white sm:flex">
      <div className="flex h-40 w-40 items-center justify-center rounded-[2rem] border border-slate-200 bg-white shadow-inner">
        <Database className="h-20 w-20 text-slate-300 transition group-hover:text-blue-400" strokeWidth={1} />
      </div>
    </div>
  );
}

function AuthArt() {
  const rows = ['priya@gmail.com', 'ravi.k@outlook.com', '', 'anil@vizag.in'];
  return (
    <div className="space-y-2 px-6 pb-6">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <div className="h-8 flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-2 font-mono text-[11px] leading-8 text-slate-400">{r || ' '}</div>
          <div className="h-8 w-16 rounded-md border border-slate-200 bg-slate-50" />
        </div>
      ))}
    </div>
  );
}

function FunctionsArt() {
  return (
    <div className="relative h-44 px-6">
      <div className="relative z-10 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 font-mono text-[11px] text-slate-600 shadow-sm">
        <span className="text-slate-400">$</span> odb functions deploy
      </div>
      <svg className="absolute -bottom-10 left-0 h-48 w-full text-slate-200" viewBox="0 0 200 160" fill="none">
        <circle cx="100" cy="120" r="95" stroke="currentColor" />
        {[20, 45, 70].map((rx) => <ellipse key={rx} cx="100" cy="120" rx={rx} ry="95" stroke="currentColor" />)}
        {[40, 80, 120].map((y) => <line key={y} x1="10" y1={y + 20} x2="190" y2={y + 20} stroke="currentColor" />)}
        <path d="M60 95 L110 70 L150 110" stroke="#3b82f6" strokeWidth="1.5" />
        {[[60, 95], [110, 70], [150, 110]].map(([x, y]) => <circle key={x} cx={x} cy={y} r="3" fill="#3b82f6" />)}
      </svg>
    </div>
  );
}

function StorageArt() {
  const icons = [ImageIcon, ImageIcon, ImageIcon, FileText, FileText, FileText, Film, Film, Film];
  return (
    <div className="grid grid-cols-3 gap-2 px-6 pb-6">
      {icons.map((I, i) => (
        <div key={i} className="flex h-10 items-center justify-center rounded-md border border-slate-200 bg-slate-50 transition group-hover:border-blue-200">
          <I className="h-4 w-4 text-slate-400" />
        </div>
      ))}
    </div>
  );
}

function RealtimeArt() {
  return (
    <div className="relative h-40">
      <div className="absolute left-10 top-6 flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1.5 shadow-sm">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-400" /><span className="h-1.5 w-1.5 rounded-full bg-slate-400" /><span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
      </div>
      <MousePointer2 className="absolute left-8 top-16 h-6 w-6 fill-white text-slate-400" />
      <MousePointer2 className="absolute bottom-6 right-12 h-5 w-5 fill-blue-100 text-blue-500 transition group-hover:translate-x-2" />
      <span className="absolute bottom-1 right-4 rounded bg-blue-500 px-1.5 py-0.5 text-[10px] font-medium text-white">Priya</span>
    </div>
  );
}

function VectorArt() {
  return (
    <div className="relative h-40 px-6">
      <svg className="absolute right-6 top-0 h-28 w-28 text-slate-300" viewBox="0 0 100 100" fill="none">
        <path d="M50 10 L88 30 L88 72 L50 92 L12 72 L12 30 Z" stroke="currentColor" />
        <path d="M12 30 L50 50 L88 30 M50 50 L50 92" stroke="currentColor" />
        {[[50, 10], [88, 30], [12, 30], [50, 50], [50, 92], [88, 72], [12, 72]].map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="2.5" className="fill-blue-500" />
        ))}
      </svg>
      <div className="absolute bottom-5 left-6 space-y-1.5 text-xs text-slate-500">
        <div className="flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /> pgvector</div>
        <div className="flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /> OpenAI &amp; Hugging Face embeddings</div>
      </div>
    </div>
  );
}

function ApiArt() {
  const tables = ['properties', 'localities', 'blog_posts', 'users', 'leads'];
  return (
    <div className="space-y-1.5 px-6 pb-6">
      {tables.map((t) => (
        <div key={t} className="flex items-center gap-2 text-[11px]">
          <span className="w-20 truncate rounded border border-slate-200 bg-slate-50 px-1.5 py-1 font-mono text-slate-500">{t}</span>
          <span className="h-px flex-1 bg-slate-200" />
          <span className="truncate rounded-full border border-slate-200 px-2 py-1 font-mono text-slate-500 transition group-hover:border-blue-200 group-hover:text-blue-600">GET /{t}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────────────── */

const navLinks = [
  { label: 'Product', href: '#product' },
  { label: 'Developers', href: '#developers' },
  { label: 'Docs', href: '/api/docs' },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white text-slate-900 antialiased">
      {/* Nav */}
      <header className="sticky top-0 z-30 border-b border-slate-100 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-600"><Database className="h-3.5 w-3.5 text-white" /></span>
              <span className="font-semibold tracking-tight">AapStack</span>
            </Link>
            <nav className="hidden items-center gap-6 text-sm text-slate-600 md:flex">
              {navLinks.map((l) => <a key={l.label} href={l.href} className="hover:text-slate-900">{l.label}</a>)}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/login" className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-300">Sign in</Link>
            <Link href="/login?mode=signup" className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500">Start your project</Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 pb-14 pt-20 sm:pt-28">
        <div className="grid gap-8 md:grid-cols-[1.6fr_1fr] md:items-end">
          <h1 className="text-4xl font-medium leading-[1.1] tracking-tight sm:text-5xl xl:text-[3.5rem]">
            Ship your backend today
            <br />
            <span className="text-blue-600">Grow without limits</span>
          </h1>
          <p className="max-w-md text-base leading-relaxed text-slate-500 md:pb-2">
            Start your project with a PostgreSQL database. Add authentication, instant APIs, functions,
            realtime, file storage and vector embeddings, hosted in Mumbai and compatible with supabase-js.
          </p>
        </div>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/login?mode=signup" className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500">
            Start your project <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <Link href="/dashboard" className="rounded-md border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-300">
            Open dashboard
          </Link>
        </div>
      </section>

      {/* Bento grid */}
      <section id="product" className="mx-auto max-w-6xl scroll-mt-20 px-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card icon={Database} title="PostgreSQL Database" className="sm:col-span-2 sm:min-h-[22rem]" art={<DatabaseArt />}>
            <p>Every project is a full <span className={hl}>PostgreSQL database</span>, the world&apos;s most trusted relational database.</p>
            <ul className="mt-6 space-y-1.5 text-xs text-slate-600 sm:mt-32">
              {['100% portable: export with pg_dump any time', 'Built-in auth with Row Level Security', 'PostGIS, pgvector, pg_trgm and more'].map((t) => (
                <li key={t} className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-blue-600" /> {t}</li>
              ))}
            </ul>
          </Card>
          <Card icon={KeyRound} title="Authentication" className="min-h-[22rem]" art={<AuthArt />}>
            <p>Add <span className={hl}>sign-ups and logins</span> with email, phone, Google and GitHub, secured by Row Level Security.</p>
          </Card>
          <Card icon={Webhook} title="Functions" className="min-h-[22rem]" art={<FunctionsArt />}>
            <p>Write custom code and <span className={hl}>run it on HTTP calls, queues or a schedule</span>, without managing servers.</p>
          </Card>

          <Card icon={HardDrive} title="Storage" className="min-h-[20rem]" art={<StorageArt />}>
            <p>Store, organize and serve <span className={hl}>large files</span>, from images to videos, with on-the-fly resizing.</p>
          </Card>
          <Card icon={Radio} title="Realtime" className="min-h-[20rem]" art={<RealtimeArt />}>
            <p>Build <span className={hl}>live, multiplayer experiences</span> with database changes, broadcast and presence.</p>
          </Card>
          <Card icon={Sparkles} title="Vector" className="min-h-[20rem]" art={<VectorArt />}>
            <p>Store, index and search <span className={hl}>vector embeddings</span> from your favourite ML models.</p>
          </Card>
          <Card icon={Code2} title="Data APIs" className="min-h-[20rem]" art={<ApiArt />}>
            <p>Instant, ready-to-use <span className={hl}>REST and GraphQL APIs</span> for every table.</p>
          </Card>
        </div>
        <p className="mt-6 text-sm text-slate-900">
          Use one or all. <span className="text-slate-500">Every product works on its own, and they all share one PostgreSQL database.</span>
        </p>
      </section>

      {/* Developers */}
      <section id="developers" className="mx-auto mt-24 max-w-6xl scroll-mt-20 px-4">
        <div className="grid gap-10 rounded-2xl border border-slate-200 bg-slate-50 p-6 sm:p-10 lg:grid-cols-2 lg:items-center">
          <div className="min-w-0">
            <h2 className="text-3xl font-medium tracking-tight">Already on Supabase?<br /><span className="text-slate-500">Switch in two lines.</span></h2>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-500">
              AapStack speaks the same API as Supabase. Keep using supabase-js, point it at your AapStack project
              and import your existing database, users and files.
            </p>
            <ul className="mt-6 space-y-2 text-sm text-slate-700">
              {['Database in Mumbai, closer to your users in India', 'Projects never pause for inactivity', 'Full SQL access, CLI and MCP server for AI tools'].map((t) => (
                <li key={t} className="flex items-center gap-2"><Check className="h-4 w-4 text-blue-600" /> {t}</li>
              ))}
            </ul>
          </div>
          <div className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-slate-950 shadow-lg">
            <div className="flex items-center gap-1.5 border-b border-slate-800 px-4 py-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-slate-700" /><span className="h-2.5 w-2.5 rounded-full bg-slate-700" /><span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
              <span className="ml-2 text-[11px] text-slate-500">app.ts</span>
            </div>
            <pre className="overflow-x-auto p-5 text-[13px] leading-relaxed text-slate-300"><code>{`import { createClient } from '@supabase/supabase-js'

const db = createClient(
  'https://aapstack.tech/p/<project-id>',
  '<anon-key>'
)

const { data } = await db
  .from('properties')
  .select('id, title, price')
  .eq('status', 'approved')`}</code></pre>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 py-24 text-center">
        <h2 className="text-3xl font-medium tracking-tight sm:text-4xl">Build on AapStack <span className="text-blue-600">today</span></h2>
        <div className="mt-6 flex justify-center gap-3">
          <Link href="/login?mode=signup" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500">Start your project</Link>
          <Link href="/login" className="rounded-md border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-300">Sign in</Link>
        </div>
      </section>

      <footer className="border-t border-slate-100">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2"><Database className="h-3.5 w-3.5 text-blue-600" /> AapStack · PostgreSQL development platform · Mumbai, India</span>
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
