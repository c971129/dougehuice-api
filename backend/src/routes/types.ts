import type { AppConfig } from "../config.js";
import type { AppStore } from "../repositories/store.js";
import type { StorageProvider } from "../storage/storage-provider.js";
import type { PaymentProvider } from "../payments/provider.js";
import type { GenerationProvider } from "../generation/provider.js";
import type { WechatMiniProgramAuthProvider } from "../wechat/mini-program-auth.js";

export interface RouteDependencies {
  config: AppConfig;
  store: AppStore;
  storage: StorageProvider;
  paymentProvider: PaymentProvider;
  generationProvider?: GenerationProvider;
  wechatAuthProvider?: WechatMiniProgramAuthProvider;
  paymentEffectLeaseMilliseconds: number;
}
