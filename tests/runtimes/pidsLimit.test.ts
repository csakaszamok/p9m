import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'

// A fork bomb in one sandbox must not use up the host's process table (every sandbox and Purgatorium stop):
// each runtime's sandbox container has a process limit, enough for its dockerd, its apps and a build
describe('the sandbox container has a process limit', () => {
  for (const runtime of ['dind', 'sysbox']) {
    it(runtime, () => {
      const doc = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'runtimes', `${runtime}.yaml`), 'utf8')) as {
        docker_compose: { services: { sandbox: { pids_limit?: number } } }
      }
      const limit = doc.docker_compose.services.sandbox.pids_limit
      expect(limit).toBeGreaterThanOrEqual(2048)
      expect(limit).toBeLessThanOrEqual(8192)
    })
  }
})
