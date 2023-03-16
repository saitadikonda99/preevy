import fs from 'fs'
import path from 'path'
import Docker from 'dockerode'
import { inspect } from 'node:util'
import pino from 'pino'
import pinoPretty from 'pino-pretty'
import { EOL } from 'os'
import createDockerClient from './src/docker'
import createWebServer from './src/web'
import { SshState, sshClient as createSshClient, checkConnection, formatPublicKey, parseSshUrl, SshConnectionConfig } from './src/ssh'
import { requiredEnv } from './src/env'
import { tunnelNameResolver } from './src/tunnel-name'
import { ConnectionCheckResult } from './src/ssh/connection-checker'

const homeDir = process.env.HOME || '/root'

const readDir = async (dir: string) => {
  try {
    return (await fs.promises.readdir(dir, { withFileTypes: true }) ?? [])
      .filter(d => d.isFile()).map(f => f.name)
  } catch (e) {
    if ((e as { code: string }).code === 'ENOENT') {
      return []
    }
    throw e
  }
}

const readAllFiles = async (dir: string) => {
  const files = await readDir(dir)
  return Promise.all(
    files.map(file => fs.promises.readFile(path.join(dir, file), { encoding: 'utf8' }))
  )
}

const sshConnectionConfigFromEnv = async (): Promise<{ connectionConfig: SshConnectionConfig; sshUrl: string }> => {
  const sshUrl = requiredEnv('SSH_URL')
  const parsed = parseSshUrl(sshUrl)

  const clientPrivateKey = process.env.SSH_PRIVATE_KEY || fs.readFileSync(
    path.join(homeDir, '.ssh', 'id_rsa'),
    { encoding: 'utf8' },
  )

  const knownServerPublicKeys = await readAllFiles(path.join(homeDir, 'known_server_keys'))

  return {
    sshUrl,
    connectionConfig: {
      ...parsed,
      clientPrivateKey,
      username: process.env.USER ?? 'foo',
      knownServerPublicKeys,
      insecureSkipVerify: Boolean(process.env.INSECURE_SKIP_VERIFY),
      tlsServerName: process.env.TLS_SERVERNAME || undefined,
    },
  }
}

const formatConnectionCheckResult = (
  r: ConnectionCheckResult,
) => {
  if ('unverifiedHostKey' in r) {
    return { unverifiedHostKey: formatPublicKey(r.unverifiedHostKey) }
  }
  if ('error' in r) {
    return { error: r.error.message || r.error.toString(), stack: r.error.stack, details: inspect(r.error) }
  }
  return r
}

const main = async () => {
  const log = pino({
    level: process.env.DEBUG || process.env.DOCKER_PROXY_DEBUG ? 'debug' : 'info',
  }, pinoPretty({ destination: pino.destination(process.stderr) }))

  const { connectionConfig, sshUrl } = await sshConnectionConfigFromEnv()

  log.debug('ssh config: %j', {
    ...connectionConfig,
    clientPrivateKey: '*** REDACTED ***',
    clientPublicKey: formatPublicKey(connectionConfig.clientPrivateKey),
  })

  if (process.env.SSH_CHECK_ONLY || process.argv.includes('check')) {
    const result = await checkConnection({
      connectionConfig,
      log: log.child({ name: 'ssh' }, { level: 'warn' }),
    })
    process.stdout.write(JSON.stringify(formatConnectionCheckResult(result)))
    process.stdout.write(EOL)
    process.exit(0)
  }

  const docker = new Docker({ socketPath: '/var/run/docker.sock' })
  const dockerClient = createDockerClient({ log: log.child({ name: 'docker' }), docker, debounceWait: 500 })

  const sshClient = await createSshClient({
    connectionConfig,
    tunnelNameResolver: tunnelNameResolver({ userDefinedSuffix: process.env.TUNNEL_URL_SUFFIX }),
    log: log.child({ name: 'ssh' }),
    onError: err => {
      log.error(err)
      process.exit(1)
    },
  })

  log.info('ssh client connected to %j', sshUrl)

  let state: SshState

  const initPromise = new Promise<void>(resolve => {
    void dockerClient.listenToContainers({
      onChange: async services => {
        state = await sshClient.updateTunnels(services)
        process.stdout.write(JSON.stringify(state))
        process.stdout.write(EOL)
        resolve()
      },
    })
  })

  const webServer = createWebServer({
    getSshState: () => initPromise.then(() => state),
  })
    .listen(process.env.PORT ?? 3000, () => {
      log.info(`listening on ${inspect(webServer.address())}`)
    })
    .on('error', err => {
      log.error(err)
      process.exit(1)
    })
    .unref()
}

void main()