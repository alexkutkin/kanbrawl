import { startServer } from '../../server/index.js';

type StartOptions = {
  stdio?: boolean;
  port?: string;
  host?: string;
  token?: string;
  allowOrigin?: string[];
};

export async function startAction(options: StartOptions): Promise<void> {
  await startServer({
    stdio: options.stdio,
    port: options.port ? Number.parseInt(options.port, 10) : undefined,
    host: options.host,
    token: options.token,
    allowOrigins: options.allowOrigin,
  });
}
