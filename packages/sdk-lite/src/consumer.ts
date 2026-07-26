export interface IdempotentStorage {
  /**
   * Check if an event ID has already been seen.
   * If it has, return true (meaning it should be skipped).
   * If it has not, mark it as seen and return false.
   */
  checkAndSet(eventId: string): Promise<boolean>;

  /**
   * Remove the event ID from storage, allowing it to be processed again.
   * This is useful if the handler fails after `checkAndSet` was called.
   */
  unset(eventId: string): Promise<void>;
}

export interface OutboxWebhookPayload {
  id: string;
  eventType: string;
  entityId: string | null;
  entityType: string | null;
  communityId: string | null;
  payload: any;
  createdAt: string;
}

/**
 * A helper for consuming outbox webhooks idempotently.
 * 
 * Since the GuildPass outbox guarantees at-least-once delivery, events may be
 * redelivered if the outbox worker crashes before marking them as delivered.
 * This consumer uses a storage interface to deduplicate events by their `id`.
 */
export class IdempotentWebhookConsumer {
  constructor(private readonly storage: IdempotentStorage) {}

  /**
   * Process an incoming webhook payload idempotently.
   * 
   * If the event's `id` has already been processed successfully (or is currently being processed),
   * this method will safely ignore the duplicate and resolve.
   * If the handler throws an error, the event `id` will be unset from storage so that
   * subsequent retries by the outbox worker can attempt processing again.
   */
  async process(
    payload: OutboxWebhookPayload,
    handler: (payload: OutboxWebhookPayload) => Promise<void>
  ): Promise<void> {
    const alreadySeen = await this.storage.checkAndSet(payload.id);
    
    if (alreadySeen) {
      // Event has already been processed or is currently being processed.
      return;
    }

    try {
      await handler(payload);
    } catch (error) {
      // If processing failed, we unset the seen flag so that a future retry 
      // from the outbox worker can be processed.
      try {
        await this.storage.unset(payload.id);
      } catch (unsetError) {
        // We log or ignore the unset error, but we must throw the original handler error
        // so the HTTP endpoint can return 500, prompting a retry.
        console.error(`[IdempotentWebhookConsumer] Failed to unset event ${payload.id} after handler error:`, unsetError);
      }
      throw error;
    }
  }
}
