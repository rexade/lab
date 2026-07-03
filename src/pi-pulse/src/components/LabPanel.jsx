import { motion } from 'framer-motion'

const SERVICES = [
  { name: 'Brain',       desc: 'Dump anything, AI files it',  href: 'https://brain.rexthedog.space',     icon: 'brain'    },
  { name: 'Notes',       desc: 'Notes & knowledge base',       href: 'https://notes.rexthedog.space',     icon: 'notes'    },
  { name: 'Receptbok',   desc: 'Recept med svenska mått',     href: 'https://recipes.rexthedog.space',   icon: 'recipes'  },
  { name: 'Kanban',      desc: 'Task board',                   href: 'https://kanban.rexthedog.space',    icon: 'kanban'   },
  { name: 'Anime',       desc: 'Track airing shows',           href: 'https://anime.rexthedog.space',     icon: 'anime'    },
  { name: 'Files',       desc: 'File storage',                 href: 'https://files.rexthedog.space',     icon: 'files'    },
  { name: 'Portainer',   desc: 'Docker management',            href: 'https://portainer.rexthedog.space', icon: 'portainer'},
  { name: 'Uptime Kuma', desc: 'Service monitoring',           href: 'https://status.rexthedog.space',    icon: 'status'   },
  { name: 'Terminal',    desc: 'SSH in the browser',            href: 'https://tty.rexthedog.space',       icon: 'terminal' },
]

function ServiceIcon({ type }) {
  const p = {
    width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round',
  }
  switch (type) {
    case 'brain': return (
      <svg {...p}>
        <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
        <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
      </svg>
    )
    case 'notes': return (
      <svg {...p}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
        <polyline points="10 9 9 9 8 9"/>
      </svg>
    )
    case 'recipes': return (
      <svg {...p}>
        <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/>
        <line x1="7" y1="2" x2="7" y2="11"/>
        <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/>
      </svg>
    )
    case 'kanban': return (
      <svg {...p}>
        <rect x="3" y="3" width="7" height="18" rx="1"/>
        <rect x="14" y="3" width="7" height="12" rx="1"/>
      </svg>
    )
    case 'files': return (
      <svg {...p}>
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
    )
    case 'anime': return (
      <svg {...p}>
        <rect x="2" y="7" width="20" height="15" rx="2" ry="2"/>
        <polyline points="17 2 12 7 7 2"/>
      </svg>
    )
    case 'portainer': return (
      <svg {...p}>
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
        <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
        <line x1="12" y1="22.08" x2="12" y2="12"/>
      </svg>
    )
    case 'status': return (
      <svg {...p}>
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
    )
    case 'vault': return (
      <svg {...p}>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    )
    case 'terminal': return (
      <svg {...p}>
        <polyline points="4 17 10 11 4 5"/>
        <line x1="12" y1="19" x2="20" y2="19"/>
      </svg>
    )
    default: return null
  }
}

export function LabPanel() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
    >
      <div className="flex items-center gap-2 mb-5">
        <span
          className="text-xs uppercase tracking-widest font-medium"
          style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}
        >
          lab · services
        </span>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        gap: 12,
      }}>
        {SERVICES.map((s, i) => (
          <motion.a
            key={s.name}
            href={s.href}
            target="_blank"
            rel="noopener noreferrer"
            className="panel"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: i * 0.04 }}
            whileHover={{
              scale: 1.02,
              boxShadow: '0 0 0 1px rgba(34,211,238,0.3), 0 8px 32px rgba(0,0,0,0.6)',
            }}
            style={{
              padding: '18px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              textDecoration: 'none',
              cursor: 'pointer',
            }}
          >
            <div style={{ color: 'var(--accent)' }}>
              <ServiceIcon type={s.icon} />
            </div>
            <div>
              <div className="font-medium text-white" style={{ fontSize: '0.875rem' }}>{s.name}</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: 3 }}>{s.desc}</div>
            </div>
          </motion.a>
        ))}
      </div>
    </motion.div>
  )
}
