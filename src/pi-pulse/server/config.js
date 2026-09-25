// Single source of truth for Pi Pulse runtime configuration.
// Every path is env-overridable so the trust smoke test can run the real
// server against a temp fixture instead of /home/admin.
import fs from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { SAFE_CLAUDE_MODEL } from '../server-core.js'

export const PI_PULSE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const PORT = Number(process.env.PORT || 8089)
export const HOST = process.env.PI_PULSE_HOST || process.env.HOST || '127.0.0.1'
export const SCHEDULES_ENABLED = process.env.PI_PULSE_DISABLE_SCHEDULES !== '1'

export const WRITE_AUTH_TOKEN = process.env.PI_PULSE_ADMIN_TOKEN || ''
export const TRUST_CLOUDFLARE_ACCESS = process.env.PI_PULSE_TRUST_CF_ACCESS === '1'
export const PROXY_WRITE_HEADER_NAMES = ['cf-connecting-ip', 'x-forwarded-for', 'cf-ray']
export const REQUIRE_WRITE_AUTH = process.env.PI_PULSE_REQUIRE_WRITE_AUTH === '1' || !!WRITE_AUTH_TOKEN || TRUST_CLOUDFLARE_ACCESS

export const MIN_SCHEDULE_INTERVAL_HOURS = Number(process.env.PI_PULSE_MIN_SCHEDULE_INTERVAL_HOURS || 0.25)
export const MAX_SCHEDULE_INTERVAL_HOURS = Number(process.env.PI_PULSE_MAX_SCHEDULE_INTERVAL_HOURS || 24)
export const MAX_CONSECUTIVE_AUTONOMOUS_FAILS = Number(process.env.PI_PULSE_MAX_CONSECUTIVE_AUTONOMOUS_FAILS || 5)
export const GENERATED_APP_CSP = "default-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'"

export const LAB_ROOT = process.env.PI_PULSE_LAB_ROOT || '/home/admin/lab'
export const INCUBATOR_REPO_ROOT = process.env.PI_PULSE_INCUBATOR_REPO_ROOT || '/home/admin'
export const PROJECTS_DIR = process.env.PI_PULSE_PROJECTS_DIR || join(LAB_ROOT, 'projects')
export const INCUBATORS_PATH = process.env.PI_PULSE_INCUBATORS_PATH || join(PROJECTS_DIR, 'incubators.json')
export const RUN_LOG_PATH = process.env.PI_PULSE_RUN_LOG_PATH || join(LAB_ROOT, 'RUN_LOG.md')
export const PROJECT_STATUS_PATH = process.env.PI_PULSE_PROJECT_STATUS_PATH || join(PROJECTS_DIR, 'pi-pulse', 'status.json')
export const LAB_SCHEDULE_PATH = process.env.PI_PULSE_LAB_SCHEDULE_PATH || join(PROJECTS_DIR, 'pi-pulse', 'schedule.json')
export const RUN_CAPTURE_DIR = process.env.PI_PULSE_RUN_CAPTURE_DIR || join(PROJECTS_DIR, '.run-capture')
export const RUN_LOCK_DIR = process.env.PI_PULSE_RUN_LOCK_DIR || join(PROJECTS_DIR, '.run-locks')
export const DAILY_SEED_PATH = process.env.PI_PULSE_DAILY_SEED_PATH || join(LAB_ROOT, 'DAILY_SEED.md')
export const CORE_SEED_PATH = process.env.PI_PULSE_CORE_SEED_PATH || join(PROJECTS_DIR, 'pi-pulse', 'seed.md')
export const CORE_FEEDBACK_JSON = process.env.PI_PULSE_CORE_FEEDBACK_JSON || join(LAB_ROOT, 'DRIFT_FEEDBACK.json')
export const CORE_FEEDBACK_MD = process.env.PI_PULSE_CORE_FEEDBACK_MD || join(LAB_ROOT, 'DRIFT_FEEDBACK.md')
export const USER_FEEDBACK_PATH = process.env.PI_PULSE_USER_FEEDBACK_PATH || join(LAB_ROOT, 'USER_FEEDBACK.md')
export const NARRATIONS_PATH = process.env.PI_PULSE_NARRATIONS_PATH || join(LAB_ROOT, 'src', 'narrator', 'narrations.jsonl')
export const GHOST_DIARY_PATH = process.env.PI_PULSE_GHOST_DIARY_PATH || join(LAB_ROOT, 'src', 'ghost', 'diary.jsonl')
export const DAY_BUFFER_PATH = process.env.PI_PULSE_DAY_BUFFER_PATH || join(PI_PULSE_ROOT, 'day-buffer.json')
export const DIST_DIR = join(PI_PULSE_ROOT, 'dist')

// Runner entrypoints. run-incubator.sh is the one implementation; the Codex and
// Claude scripts are thin compatibility shims referenced by existing status.json
// files, so their paths must stay stable.
export const INCUBATOR_RUNNER_SCRIPT = process.env.PI_PULSE_INCUBATOR_RUNNER_SCRIPT || join(PI_PULSE_ROOT, 'scripts', 'run-incubator.sh')
export const GENERIC_CLAUDE_INCUBATOR_SCRIPT = process.env.PI_PULSE_CLAUDE_INCUBATOR_SCRIPT || join(PI_PULSE_ROOT, 'scripts', 'run-claude-incubator.sh')
export const CODEX_INCUBATOR_SCRIPT = process.env.PI_PULSE_CODEX_INCUBATOR_SCRIPT || join(LAB_ROOT, 'scripts', 'run-codex-incubator.sh')
export const DEFAULT_LAB_RUNNER = 'codex'
export const DEFAULT_CLAUDE_MODEL = process.env.PI_PULSE_DEFAULT_CLAUDE_MODEL || SAFE_CLAUDE_MODEL
export const DEFAULT_RUN_TYPES = ['mutate', 'research', 'mutate']

// Local critic (Ollama/Qwen via hailo-ollama). Disabled by default because CPU
// fallback saturates the Pi; opt in only for deliberate local inference sessions.
export const LOCAL_LLM_ENABLED = process.env.PI_PULSE_ENABLE_LOCAL_LLM === '1'
export const HAILO_URL = process.env.PI_PULSE_OLLAMA_URL || 'http://localhost:11434'
export const AI_MODEL = process.env.PI_PULSE_OLLAMA_MODEL || 'qwen2.5-instruct:1.5b'
export const MEMPALACE_BIN = process.env.PI_PULSE_MEMPALACE_BIN || '/home/admin/.local/bin/mempalace'
export const MEMPALACE_HOME = process.env.PI_PULSE_MEMPALACE_HOME || '/home/admin'

function sourceFilesIn(dir, extensions) {
  try {
    return fs.readdirSync(dir)
      .filter(name => extensions.some(ext => name.endsWith(ext)))
      .sort()
      .map(name => join(dir, name))
  } catch {
    return []
  }
}

// Files whose change means the running service is stale (see requireFreshSource).
export const SOURCE_HEALTH_FILES = [
  join(PI_PULSE_ROOT, 'server.js'),
  join(PI_PULSE_ROOT, 'server-core.js'),
  ...sourceFilesIn(join(PI_PULSE_ROOT, 'server'), ['.js']),
  join(PI_PULSE_ROOT, 'scripts', 'run-incubator.sh'),
  join(PI_PULSE_ROOT, 'scripts', 'run-claude-incubator.sh'),
  ...sourceFilesIn(join(PI_PULSE_ROOT, 'scripts', 'lib'), ['.mjs', '.sh']),
  join(PI_PULSE_ROOT, 'scripts', 'app-evidence.mjs'),
  ...String(process.env.PI_PULSE_SOURCE_HEALTH_FILES || '').split(':').filter(Boolean),
]
