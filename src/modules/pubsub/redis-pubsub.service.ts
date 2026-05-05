import { createClient, RedisClientType } from 'redis';
import { MessageBus } from './message-bus.interface';
import { logger } from '../../utils/logger';

export class RedisPubSubService implements MessageBus {
  private publisher: RedisClientType;

  constructor() {
    this.publisher = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    });

    this.publisher.connect().catch((err) => {
      logger.error('Redis Publisher Connection Failed', err);
    });
  }

  async publish<T = any>(channel: string, message: T): Promise<void> {
    const payload = JSON.stringify(message);
    await this.publisher.publish(channel, payload);

    logger.debug(`Published to ${channel}`);
  }

  async subscribe(): Promise<void> {
    throw new Error('Use RedisSubscriberService for subscriptions');
  }

  async disconnect() {
    await this.publisher.quit();
  }
}