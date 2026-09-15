import type { FastifyInstance } from 'fastify';
import { db } from '../db/pool.js';
import { config } from '../config.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    try {
      await db().query('SELECT 1');
    } catch {
      return reply.code(503).send({ status: 'degraded', database: 'unreachable' });
    }
    const cfg = config();
    return {
      status: 'ok',
      database: 'ok',
      chain: { chain_id: cfg.chain.chainId, contract: cfg.chain.l2Contract },
      signer_configured: Boolean(cfg.chain.claimSignerKey),
      rpc_configured: Boolean(cfg.chain.rpcUrl),
    };
  });
}
