import { readFile } from "node:fs/promises";

import type { AppConfig } from "../config.js";
import { WechatPayV3Provider } from "./wechat-pay-v3-provider.js";

/** Build the shared production payment adapter without duplicating key loading in API and Worker entrypoints. */
export async function createConfiguredPaymentProvider(
  config: AppConfig,
): Promise<WechatPayV3Provider | undefined> {
  if (!config.wechatAppId
    || !config.wechatPayMerchantId
    || !config.wechatPayMerchantCertificateSerial
    || !config.wechatPayMerchantPrivateKeyPath
    || !config.wechatPayVerifierSerial
    || !config.wechatPayVerifierPublicKeyPath
    || !config.wechatPayApiV3Key
    || !config.wechatPayNotifyUrl) return undefined;

  const additionalVerifierEntries = Object.entries(config.wechatPayAdditionalVerifierPublicKeyPaths ?? {});
  const [merchantPrivateKeyPem, verifierPublicKeyPem, ...additionalVerifierPublicKeyPems] = await Promise.all([
    readFile(config.wechatPayMerchantPrivateKeyPath),
    readFile(config.wechatPayVerifierPublicKeyPath),
    ...additionalVerifierEntries.map(([, path]) => readFile(path)),
  ]);
  const additionalVerifierPublicKeys = Object.fromEntries(
    additionalVerifierEntries.map(([serial], index) => [serial, additionalVerifierPublicKeyPems[index]!] as const),
  );
  return new WechatPayV3Provider({
    appId: config.wechatAppId,
    merchantId: config.wechatPayMerchantId,
    merchantCertificateSerial: config.wechatPayMerchantCertificateSerial,
    merchantPrivateKeyPem,
    verifierSerial: config.wechatPayVerifierSerial,
    verifierPublicKeyPem,
    ...(additionalVerifierEntries.length > 0 ? { additionalVerifierPublicKeys } : {}),
    apiV3Key: config.wechatPayApiV3Key,
    notifyUrl: config.wechatPayNotifyUrl,
  });
}
