import Link from 'next/link';
import {
  ArrowLeftRight, BookOpen, Bot, Briefcase, Building2, ChevronDown, Code2, Database, GitBranch,
  GraduationCap, Home, Landmark, Layers, LogIn, Menu, PlayCircle, Rocket, Server, ShoppingBag,
  Terminal, Trophy, Users, Activity,
} from 'lucide-react';

type Item = { icon: React.ComponentType<{ className?: string }>; label: string; href: string };

const REPO = 'https://github.com/prasadkumarg202/Owndatabase';

const solutions: { title: string; items: Item[] }[] = [
  {
    title: 'Who it’s for',
    items: [
      { icon: Rocket, label: 'Startups', href: '/#for-startups' },
      { icon: Users, label: 'Agencies', href: '/#for-agencies' },
      { icon: Trophy, label: 'Hackathon teams', href: '/#for-hackathons' },
      { icon: Building2, label: 'Growing businesses', href: '/#for-business' },
    ],
  },
  {
    title: 'App type',
    items: [
      { icon: Layers, label: 'SaaS & B2B', href: '/#app-saas' },
      { icon: ShoppingBag, label: 'Marketplaces & e-commerce', href: '/#app-marketplace' },
      { icon: Home, label: 'Real estate & listings', href: '/#app-realestate' },
      { icon: Landmark, label: 'Fintech & payments', href: '/#app-fintech' },
      { icon: GraduationCap, label: 'EdTech', href: '/#app-edtech' },
      { icon: Bot, label: 'AI apps & agents', href: '/#app-ai' },
    ],
  },
];

const migration: Item[] = [
  { icon: ArrowLeftRight, label: 'Switch from Supabase', href: '/#developers' },
  { icon: Server, label: 'Run it on your own server', href: REPO },
];

const developers: { title: string; items: Item[] }[] = [
  {
    title: 'Developers',
    items: [
      { icon: BookOpen, label: 'API reference', href: '/api/docs' },
      { icon: Code2, label: 'Quickstart', href: '/#developers' },
      { icon: Terminal, label: 'CLI & MCP server', href: '/#developers' },
      { icon: Activity, label: 'System status', href: '/status' },
    ],
  },
  {
    title: 'Resources',
    items: [
      { icon: GitBranch, label: 'Source on GitHub', href: REPO },
      { icon: PlayCircle, label: 'Console tour', href: '/#showcase' },
      { icon: Database, label: 'Supabase-compatible SDKs', href: '/#developers' },
      { icon: Briefcase, label: 'Pricing', href: '/#pricing' },
    ],
  },
];

const whatsNew = [
  { title: 'Import from Supabase', body: 'Bring an existing project across: schema, data, users and files.' },
  { title: 'Phone OTP through any SMS gateway', body: 'Built-in Twilio, plus MSG91, Gupshup, AWS SNS or WhatsApp through a webhook.' },
  { title: 'GST tax invoices', body: 'Invoices with GSTIN, place of supply and the CGST, SGST and IGST breakdown.' },
];

function MenuLink({ icon: Icon, label, href }: Item) {
  const external = href.startsWith('http');
  const cls = 'flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-slate-700 hover:bg-slate-50 hover:text-slate-900';
  const body = <><Icon className="h-4 w-4 shrink-0 text-slate-400" />{label}</>;
  return external
    ? <a href={href} target="_blank" rel="noreferrer" className={cls}>{body}</a>
    : <Link href={href} className={cls}>{body}</Link>;
}

function Dropdown({ label, children, align = 'left' }: { label: string; children: React.ReactNode; align?: 'left' | 'center' }) {
  return (
    <div className="group relative">
      <button type="button" className="flex items-center gap-1 py-5 text-sm text-slate-300 hover:text-white group-focus-within:text-white" aria-haspopup="true">
        {label} <ChevronDown className="h-3.5 w-3.5 transition group-hover:rotate-180 group-focus-within:rotate-180" />
      </button>
      <div
        className={`invisible absolute top-full z-40 pt-1 opacity-0 transition duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 ${align === 'center' ? 'left-1/2 -translate-x-1/2' : '-left-4'}`}
      >
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl">{children}</div>
      </div>
    </div>
  );
}

function Col({ title, items }: { title: string; items: Item[] }) {
  return (
    <div className="min-w-[13rem]">
      <p className="mb-2 px-2 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400">{title}</p>
      {items.map((i) => <MenuLink key={i.label} {...i} />)}
    </div>
  );
}

export function SiteNav() {
  return (
    <header className="absolute inset-x-0 top-0 z-30">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-cyan-400 shadow-lg shadow-blue-500/30"><Database className="h-4 w-4 text-white" /></span>
            <span className="text-lg font-semibold tracking-tight text-white">AapStack</span>
          </Link>

          <nav className="hidden items-center gap-6 lg:flex" aria-label="Main">
            <a href="#integrations" className="text-sm text-slate-300 hover:text-white">Product</a>

            <Dropdown label="Solutions">
              <div className="flex">
                <div className="flex gap-6 p-6">
                  {solutions.map((c) => <Col key={c.title} {...c} />)}
                </div>
                <div className="w-64 border-l border-slate-100 bg-slate-50 p-6">
                  <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400">Migration</p>
                  <div className="space-y-2">
                    {migration.map(({ icon: Icon, label, href }) => (
                      <a key={label} href={href} {...(href.startsWith('http') ? { target: '_blank', rel: 'noreferrer' } : {})}
                        className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium hover:border-blue-300">
                        <Icon className="h-4 w-4 text-slate-500" /> {label}
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            </Dropdown>

            <Dropdown label="Developers">
              <div className="flex">
                <div className="flex gap-6 p-6">
                  {developers.map((c) => <Col key={c.title} {...c} />)}
                </div>
                <div className="w-80 border-l border-slate-100 p-6">
                  <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400">What’s new</p>
                  <div className="space-y-4">
                    {whatsNew.map((n) => (
                      <div key={n.title}>
                        <p className="text-sm font-medium">{n.title}</p>
                        <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{n.body}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Dropdown>

            <a href="#pricing" className="text-sm text-slate-300 hover:text-white">Pricing</a>
            <a href="/api/docs" className="text-sm text-slate-300 hover:text-white">Docs</a>
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <Link href="/login" className="hidden px-3 py-2 text-sm text-slate-200 hover:text-white sm:block">Sign in</Link>
          <Link href="/login?mode=signup" className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-blue-50">Start free</Link>

          {/* Mobile menu */}
          <details className="group relative lg:hidden">
            <summary className="flex cursor-pointer list-none items-center rounded-lg p-2 text-slate-200 hover:text-white [&::-webkit-details-marker]:hidden" aria-label="Open menu">
              <Menu className="h-5 w-5" />
            </summary>
            <div className="absolute right-0 top-full mt-2 max-h-[80vh] w-72 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 text-slate-900 shadow-2xl">
              <Col title="Solutions" items={[...solutions[0].items, ...solutions[1].items]} />
              <div className="my-3 border-t border-slate-100" />
              <Col title="Developers" items={[...developers[0].items, ...developers[1].items]} />
              <div className="my-3 border-t border-slate-100" />
              <MenuLink icon={LogIn} label="Sign in" href="/login" />
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}
