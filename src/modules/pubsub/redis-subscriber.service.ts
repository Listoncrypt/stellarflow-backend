import { createClient, RedisClientType } from 'redis';
import { CHANNELS } from '../constants/channels';
import { PriceCacheService } from '../../cache/price-cache.service';
import { logger } from '../../utils/logger';

export class RedisSubscriberService {
  private subscriber: RedisClientType;

  constructor(private readonly priceCache: PriceCacheService) {
    this.subscriber = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    });
  }

  async init() {
    await this.subscriber.connect();

    await this.subscriber.subscribe(CHANNELS.PRICE_UPDATES, (message) => {
      try {
        const data = JSON.parse(message);
        this.handlePriceUpdate(data);
      } catch (err) {
        logger.error('Invalid message received', err);
      }
    });

    logger.info('Redis Subscriber listening...');
  }

  private handlePriceUpdate(data: any) {
    const { symbol, price } = data;

    this.priceCache.set(symbol, price);

    logger.debug(`Synced price: ${symbol} = ${price}`);
  }

  async disconnect() {
    await this.subscriber.quit();
  }
}