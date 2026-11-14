import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { copySandboxDir, readSandboxFile, readSandboxFileIfAny, writeSandboxFile } from '../../services/sandboxFs'

// Root in a sandbox could write its /inner and /certs (before 0.12.22): a symlink there must never lead Purgatorium,
// which reads and writes them as root, to one of its own files
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p9m-sbfs-'))
// Making a symlink needs a privilege on Windows: those cases run on Linux (CI)
const symlinks = process.platform !== 'win32'

describe('readSandboxFile', () => {
  it('reads a plain file, within the size limit', () => {
    const d = tmp()
    fs.mkdirSync(`${d}/inner`)
    fs.writeFileSync(`${d}/inner/docker-compose.yml`, 'services: {}\n')
    expect(readSandboxFile(d, 'inner/docker-compose.yml')).toBe('services: {}\n')
    expect(() => readSandboxFile(d, 'inner/docker-compose.yml', 4)).toThrow('Larger than 4 bytes')
    expect(readSandboxFileIfAny(d, 'inner/missing.yml')).toBeNull()
    expect(() => readSandboxFile(d, '../x')).toThrow('Not a path in the sandbox')
  })

  it.runIf(symlinks)('refuses a symlinked file and a symlinked folder on the way', () => {
    const d = tmp(), secret = path.join(tmp(), 'environ')
    fs.writeFileSync(secret, 'ADMIN_TOKEN=x')
    fs.mkdirSync(`${d}/inner`)
    fs.symlinkSync(secret, `${d}/inner/docker-compose.yml`)
    expect(() => readSandboxFile(d, 'inner/docker-compose.yml')).toThrow()
    expect(readSandboxFileIfAny(d, 'inner/docker-compose.yml')).toBeNull()
    fs.mkdirSync(`${d}/certs`)
    fs.symlinkSync(path.dirname(secret), `${d}/certs/client`)
    expect(() => readSandboxFile(d, 'certs/client/environ')).toThrow('Not a folder')
  })

  // A FIFO opened for reading without O_NONBLOCK waits for a writer: Purgatorium would hang on it
  it.runIf(symlinks)('readSandboxFile on a FIFO throws "Not a file" without blocking', () => {
    const d = tmp()
    fs.mkdirSync(`${d}/inner`)
    execFileSync('mkfifo', [`${d}/inner/docker-compose.yml`])
    expect(() => readSandboxFile(d, 'inner/docker-compose.yml')).toThrow('Not a file')
  })
})

describe('copySandboxDir', () => {
  // Guest root (under Kata, host root) can plant setuid files, links and FIFOs in a sandbox's directory
  it.runIf(symlinks)('copySandboxDir copies regular files with normalized modes and skips the rest', () => {
    const src = tmp(), dest = path.join(tmp(), 'config')
    fs.writeFileSync(`${src}/docker-compose.yml`, 'services: {}\n')
    fs.chmodSync(`${src}/docker-compose.yml`, 0o640)
    fs.writeFileSync(`${src}/suid`, '#!/bin/sh\n')
    fs.chmodSync(`${src}/suid`, 0o4755)
    fs.mkdirSync(`${src}/certs`)
    fs.writeFileSync(`${src}/certs/ca.pem`, 'ca')
    fs.symlinkSync('/etc/passwd', `${src}/passwd`)
    execFileSync('mkfifo', [`${src}/fifo`])
    fs.mkdirSync(`${src}/ssh-host-keys`)
    fs.writeFileSync(`${src}/ssh-host-keys/key`, 'k')
    copySandboxDir(src, dest, ['ssh-host-keys'])
    const mode = (p: string) => fs.statSync(path.join(dest, p)).mode & 0o7777
    expect(mode('.')).toBe(0o700)
    expect(fs.readFileSync(`${dest}/docker-compose.yml`, 'utf8')).toBe('services: {}\n')
    expect(mode('docker-compose.yml')).toBe(0o600)
    expect(mode('suid')).toBe(0o644)
    expect(mode('certs')).toBe(0o700)
    expect(fs.readFileSync(`${dest}/certs/ca.pem`, 'utf8')).toBe('ca')
    expect(fs.readdirSync(dest).sort()).toEqual(['certs', 'docker-compose.yml', 'suid'])
  })
})

describe('writeSandboxFile', () => {
  it('writes a new file with its mode, making the folders', () => {
    const d = tmp()
    writeSandboxFile(d, 'certs/client/key.pem', 'k', 0o600)
    expect(fs.readFileSync(`${d}/certs/client/key.pem`, 'utf8')).toBe('k')
    if (process.platform !== 'win32') expect(fs.statSync(`${d}/certs/client/key.pem`).mode & 0o777).toBe(0o600)
    writeSandboxFile(d, 'certs/client/key.pem', 'k2', 0o600)
    expect(fs.readFileSync(`${d}/certs/client/key.pem`, 'utf8')).toBe('k2')
  })

  it.runIf(symlinks)('replaces a symlink instead of writing through it, and refuses a symlinked folder', () => {
    const d = tmp(), target = path.join(tmp(), 'tls.yml')
    fs.writeFileSync(target, 'mine')
    fs.mkdirSync(`${d}/certs/server`, { recursive: true })
    fs.symlinkSync(target, `${d}/certs/server/cert.pem`)
    writeSandboxFile(d, 'certs/server/cert.pem', 'cert')
    expect(fs.readFileSync(target, 'utf8')).toBe('mine')
    expect(fs.lstatSync(`${d}/certs/server/cert.pem`).isSymbolicLink()).toBe(false)
    fs.symlinkSync(path.dirname(target), `${d}/certs/client`)
    expect(() => writeSandboxFile(d, 'certs/client/tls.yml', 'x')).toThrow('Not a folder')
    expect(fs.readFileSync(target, 'utf8')).toBe('mine')
  })
})
