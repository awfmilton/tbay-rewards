import { createHmac } from 'node:crypto';
import { db } from '../db/pool.js';

/**
 * Deliver queued webhooks to retailer storefronts.
 *
 * Every body is signed so the receiving plugin can prove the call came from us:
 *   X-TBAY-Signature: sha256=<hmac(secret, timestamp + "." + body)>
 * The timestamp is inside the signed material so a captured delivery cannot be
 * replayed later against a receiver that enforces a freshness window.
 */
export async function deliverWebhooks(limit = 25): Promise<number> {
  const { rows } = await db().query<{
    id: string;
    url: string;
    secret: string;
    topic: string;
    payload: unknown;
    attempts: number;
  }>(
    `UPDATE webhook_deliveries d SET attempts = d.attempts + 1
       FROM webhooks w
      WHERE w.id = d.webhook_id
        AND d.id IN (
          SELECT id FROM webhook_deliveries
           WHERE status = 'queued' AND next_attempt_at <= now() AND attempts < 6
           ORDER BY next_attempt_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
      RETURNING d.id, w.url, w.secret, d.topic, d.payload, d.attempts`,
    [limit],
  );

  let delivered = 0;

  for (const row of rows) {
    const body = JSON.stringify({ topic: row.topic, data: row.payload });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', row.secret).update(`${timestamp}.${body}`).digest('hex');

    try {
      const response = await fetch(row.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tbay-topic': row.topic,
          'x-tbay-timestamp': timestamp,
          'x-tbay-signature': `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        await db().query(
          `UPDATE webhook_deliveries
              SET status = 'delivered', delivered_at = now(), response_code = $2, error = NULL
            WHERE id = $1`,
          [row.id, response.status],
        );
        delivered += 1;
      } else {
        await scheduleRetry(row.id, row.attempts, `HTTP ${response.status}`, response.status);
      }
    } catch (err) {
      await scheduleRetry(row.id, row.attempts, err instanceof Error ? err.message : String(err), null);
    }
  }

  return delivered;
}

async function scheduleRetry(
  id: string,
  attempts: number,
  error: string,
  responseCode: number | null,
): Promise<void> {
  // Exponential backoff: 1m, 2m, 4m, 8m, 16m, then give up.
  const delaySeconds = Math.min(2 ** attempts, 16) * 60;
  await db().query(
    `UPDATE webhook_deliveries
        SET status = CASE WHEN attempts >= 6 THEN 'failed' ELSE 'queued' END,
            next_attempt_at = now() + ($2 || ' seconds')::interval,
            response_code = $3,
            error = $4
      WHERE id = $1`,
    [id, String(delaySeconds), responseCode, error.slice(0, 500)],
  );
}
