/**
 * Lazy, best-effort access to sharp.
 *
 * A profile-installed bundle is usually a *link* to a workspace directory, so a
 * bare `import('sharp')` resolves from that directory (Node resolves symlinks)
 * and may not find the copy the Host itself loads from the profile. And a linked
 * package's dependencies are not necessarily installed into the profile, so the
 * profile copy can be missing entirely.
 *
 * The loader therefore walks a list of roots and, for each one, tries CommonJS
 * `require` first and dynamic `import` second — CJS matters because DSH ships
 * sharp inside `app.asar`, which Electron's `require` can read and the ESM
 * loader cannot.
 *
 *   1. bare `import('sharp')` — a local `node_modules` (dev checkout, CI);
 *   2. `DSH_PROFILE_DIR` / `$DSH_PROFILE` / every profile directory — the copy
 *      pnpm installed for registry deployments;
 *   3. the running DSH installation (`app.asar` / unpacked resources) — the copy
 *      the Host itself already loaded, so no second libvips is created;
 *   4. give up: the plugin degrades to pure pass-through with one warning.
 */
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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

  // The running DSH installation. In a packaged Electron app `resourcesPath`
  // points at `<install>/resources`, so sharp lives inside `app.asar`.
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    push(join(process.resourcesPath, 'app.asar', 'dsh'))
  }
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    push(join(dirname(process.execPath), 'resources', 'app.asar', 'dsh'))
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
 * Resolve and load sharp from one package root.
 *
 * @param {string} root directory owning a `node_modules` tree.
 * @returns {Promise<Function | null>} callable sharp, or null when this root has none.
 */
async function loadFrom(root) {
  const require = createRequire(join(root, 'package.json'))
  const resolved = require.resolve('sharp')

  // CommonJS first: Electron's asar-aware require loads sharp from `app.asar`,
  // and loading the same resolved file twice yields the same module instance.
  try {
    const sharp = callable(require(resolved))
    if (sharp !== null) return sharp
  } catch {
    // Fall through to the ESM loader for an ESM-only build.
  }

  return callable(await import(pathToFileURL(resolved).href))
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
    const sharp = callable(await import('sharp'))
    if (sharp !== null) {
      cached = { sharp }
      return sharp
    }
    attempts.push(new Error('sharp module exposes no callable export'))
  } catch (error) {
    attempts.push(error)
  }

  for (const root of candidateRoots()) {
    try {
      const sharp = await loadFrom(root)
      if (sharp !== null) {
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
