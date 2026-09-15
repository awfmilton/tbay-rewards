import type { FastifyInstance } from 'fastify';
import { db } from '../db/pool.js';
import { config } from '../config.js';
import { preflight } from '../lib/preflight.js';
import { supplyStatus } from '../services/token.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    try {
      await db().query('SELECT 1');
    } catch {
      return reply.code(503).send({ status: 'degraded', database: 'unreachable' });
    }
    const cfg = config();
    const findings = preflight();

    return {
      status: findings.some((f) => f.level === 'error') ? 'misconfigured' : 'ok',
      database: 'ok',
      chain: { chain_id: cfg.chain.chainId, contract: cfg.chain.l2Contract },
      signer_configured: Boolean(cfg.chain.claimSignerKey),
      rpc_configured: Boolean(cfg.chain.rpcUrl),
      supply: await supplyStatus(),
      // Named so an operator can see what needs attention without reading logs.
      preflight: findings,
    };
  });
}
