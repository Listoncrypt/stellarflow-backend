import dotenv from 'dotenv';
import { createSigner, SignerConfig } from './signer.factory';
import { ISigner } from './signer.interface';

dotenv.config();

export * from './signer.interface';
export * from './kms-signer.service';
export * from './local-signer.service';
export * from './signer.factory';

function buildConfig(): SignerConfig {
  return {
    backend: (process.env.SIGNER_BACKEND as 'kms' | 'local') || 'local',
    kmsKeyId: process.env.AWS_KMS_KEY_ID,
    kmsRegion: process.env.AWS_REGION,
    stellarPublicKey: process.env.STELLAR_PUBLIC_KEY,
    localSecret:
      process.env.STELLAR_SECRET ||
      process.env.ORACLE_SECRET_KEY ||
      process.env.SOROBAN_ADMIN_SECRET,
  };
}

/**
 * Lazily-initialized signer proxy.
 *
 * The real ISigner is only constructed on the FIRST method call.
 * This means importing this module during tests does NOT cause the
 * factory to validate secrets at module-load time, preventing
 * ConfigurationError / invalid-strkey crashes in unit tests that
 * never actually invoke the signer.
 */
let _instance: ISigner | undefined;

export const signer: ISigner = new Proxy({} as ISigner, {
  get(_target, prop: string | symbol) {
    if (!_instance) {
      _instance = createSigner(buildConfig());
    }
    return (_instance as any)[prop];
  },
});
