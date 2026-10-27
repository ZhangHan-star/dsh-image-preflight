/**
 * Lazy, best-effort access to sharp.
 *
 * A profile-installed bundle is usually a *link* to a workspace directory, so a
 * bare `import('sharp')` resolves from that directory (Node resolves symlinks)
 * and may not find the copy the Host itself loads from the profile. The loader
 * therefore tries three strategies in order and never throws at activation:
 *
 *   1. bare `import('sharp')` — works when the package is copied into a profile;
 *   2. resolve from `DSH_PROFILE_DIR` / `$DSH_PROFILE` / every profile directory;
 *   3. give up: the plugin degrades to pure pass-through with one warning.
 */
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** @type {{ sharp?: Function, error?: Error } | null} */
let cached = null

/**
 * @returns {string[]} candidate package roots that may contain `node_modules/sharp`.
 */
function candidateRoots() {
  const roots = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !roots.includes(value)) roots.push(value)
  }
  push(process.env.DSH_PROFILE_DIR)
  const profilesRoot = join(homedir(), '.dsh', 'profiles')
  push(process.env.DSH_PROFILE ? join(profilesRoot, process.env.DSH_PROFILE) : undefined)
  try {
    for (const name of readdirSync(profilesRoot)) push(join(profilesRoot, name))
  } catch {
    // No profiles directory: nothing else to try.
  }
  return roots
}

/**
 * Ensure a resolved CJS/ESM module namespace yields the callable sharp export.
 *
 * @param {any} module namespace or function.
 * @returns {Function | null} callable sharp, or null.
 */
function callable(module) {
  if (typeof module === 'function') return module
  if (typeof module?.default === 'function') return module.default
  return null
}

/**
 * Load sharp once per process, caching both success and failure.
 *
 * @returns {Promise<Function>} the callable sharp constructor.
 * @throws when every resolution strategy failed.
 */
export async function loadSharp() {
  if (cached?.sharp) return cached.sharp
  if (cached?.error) throw cached.error

  const attempts = []
  try {
    const module = await import('sharp')
    const sharp = callable(module)
    if (sharp) {
      cached = { sharp }
      return sharp
    }
    attempts.push(new Error('sharp module exposes no callable export'))
  } catch (error) {
    attempts.push(error)
  }

  for (const root of candidateRoots()) {
    try {
      const resolved = createRequire(join(root, 'package.json')).resolve('sharp')
      const module = await import(pathToFileURL(resolved).href)
      const sharp = callable(module)
      if (sharp) {
        cached = { sharp }
        return sharp
      }
      attempts.push(new Error(`sharp at ${root} exposes no callable export`))
    } catch (error) {
      attempts.push(error)
    }
  }

  const detail = attempts
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .filter((message) => message !== '')
    .join(' | ')
  const error = new Error(`dsh-image-preflight: sharp is unavailable (${detail})`)
  error.cause = attempts[attempts.length - 1]
  cached = { error }
  throw error
}

/** Test seam: forget the cached probe outcome. */
export function resetSharpCache() {
  cached = null
}
