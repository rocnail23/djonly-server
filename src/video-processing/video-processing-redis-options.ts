import { envs } from 'src/config/envs';

export function buildVideoProcessingRedisConnection(): {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
} {
  return {
    host: envs.REDIS_HOST,
    port: envs.REDIS_PORT,
    password: envs.REDIS_PASSWORD,
  };
}
