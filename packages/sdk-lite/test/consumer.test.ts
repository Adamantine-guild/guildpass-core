import { IdempotentWebhookConsumer, IdempotentStorage, OutboxWebhookPayload } from '../src/consumer';

class MockStorage implements IdempotentStorage {
  private store = new Set<string>();
  
  async checkAndSet(eventId: string): Promise<boolean> {
    if (this.store.has(eventId)) {
      return true;
    }
    this.store.add(eventId);
    return false;
  }
  
  async unset(eventId: string): Promise<void> {
    this.store.delete(eventId);
  }
}

describe('IdempotentWebhookConsumer', () => {
  let storage: MockStorage;
  let consumer: IdempotentWebhookConsumer;
  
  beforeEach(() => {
    storage = new MockStorage();
    consumer = new IdempotentWebhookConsumer(storage);
  });
  
  const mockPayload: OutboxWebhookPayload = {
    id: 'evt_123',
    eventType: 'TEST_EVENT',
    entityId: null,
    entityType: null,
    communityId: 'com_456',
    payload: { foo: 'bar' },
    createdAt: new Date().toISOString(),
  };

  it('processes a new event', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    
    await consumer.process(mockPayload, handler);
    
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(mockPayload);
  });

  it('skips an already processed event', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    
    // First call should process
    await consumer.process(mockPayload, handler);
    expect(handler).toHaveBeenCalledTimes(1);
    
    // Second call should skip
    await consumer.process(mockPayload, handler);
    expect(handler).toHaveBeenCalledTimes(1); // Still 1
  });

  it('unsets the ID and throws if handler fails', async () => {
    const error = new Error('Handler failed');
    const handler = jest.fn().mockRejectedValue(error);
    
    await expect(consumer.process(mockPayload, handler)).rejects.toThrow('Handler failed');
    
    // Should be able to process again since it was unset
    const successHandler = jest.fn().mockResolvedValue(undefined);
    await consumer.process(mockPayload, successHandler);
    
    expect(successHandler).toHaveBeenCalledTimes(1);
  });
});
