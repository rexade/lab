import { motion } from 'framer-motion'
import { Eyebrow } from './ui.jsx'

const SERVICES = [
  { name: 'Brain', desc: 'Dump anything, AI files it', href: 'https://brain.rexthedog.space', icon: 'brain' },
  { name: 'Notes', desc: 'Notes and knowledge base', href: 'https://notes.rexthedog.space', icon: 'notes' },
  { name: 'Receptbok', desc: 'Recept med svenska mått', href: 'https://recipes.rexthedog.space', icon: 'recipes' },
  { name: 'Kanban', desc: 'Task board', href: 'https://kanban.rexthedog.space', icon: 'kanban' },
  { name: 'Anime', desc: 'Track airing shows', href: 'https://anime.rexthedog.space', icon: 'anime' },
  { name: 'Files', desc: 'File storage', href: 'https://files.rexthedog.space', icon: 'files' },
  { name: 'Portainer', desc: 'Docker management', href: 'https://portainer.rexthedog.space', icon: 'portainer' },
  { name: 'Uptime Kuma', desc: 'Service monitoring', href: 'https://status.rexthedog.space', icon: 'status' },
  { name: 'Terminal', desc: 'SSH in the browser', href: 'https://tty.rexthedog.space', icon: 'terminal' },
]

const ICON_PATHS = {
  brain: ['M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z', 'M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z'],
  notes: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8'],
  recipes: ['M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2', 'M7 2v9', 'M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7'],
  kanban: ['M4 3h6v18H4z', 'M14 3h6v12h-6z'],
  anime: ['M4 7h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z', 'M17 2l-5 5-5-5'],
  files: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'],
  portainer: ['M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z', 'M3.27 6.96L12 12.01l8.73-5.05', 'M12 22.08V12'],
  status: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  terminal: ['M4 17l6-6-6-6', 'M12 19h8'],
}

function ServiceIcon({ type }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {(ICON_PATHS[type] || []).map(d => <path key={d} d={d} />)}
    </svg>
  )
}

export function ServicesView() {
  return (
    <section className="glass p-3 sm:p-4" aria-label="Home services">
      <div className="px-3 pb-2 pt-3"><Eyebrow>Home services</Eyebrow></div>
      <div className="grid gap-1 md:grid-cols-2">
        {SERVICES.map((service, index) => (
          <motion.a
            key={service.name}
            href={service.href}
            target="_blank"
            rel="noopener noreferrer"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: index * 0.03 }}
            className="focus-ring group flex items-center gap-4 rounded-[16px] px-3 py-3 transition-colors hover:bg-white/[0.04]"
          >
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] border border-white/[0.07] bg-white/[0.03] text-accent transition-shadow group-hover:shadow-[0_0_24px_-6px_var(--accent-glow)]">
              <ServiceIcon type={service.icon} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-medium text-fg">{service.name}</span>
              <span className="block truncate text-[13px] text-fg4">{service.desc}</span>
            </span>
            <span className="hidden truncate font-mono text-[12px] text-fg4 lg:block">{new URL(service.href).host}</span>
            <span aria-hidden="true" className="text-fg4 transition-transform group-hover:translate-x-0.5 group-hover:text-fg">↗</span>
          </motion.a>
        ))}
      </div>
    </section>
  )
}
