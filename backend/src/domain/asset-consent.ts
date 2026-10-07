import { createHash } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { AssetConsentPolicySnapshot } from "./models.js";
import { AppError } from "../errors.js";

const DEVELOPMENT_PROCESSOR = "development-placeholder-processor";
const DEVELOPMENT_PURPOSE = "development-placeholder: AI 素材仅用于本地拼豆图纸生成测试";

function assertPolicyText(name: string, value: string, maximumLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${name} 必须是 1-${maximumLength} 个不含控制字符的文本`);
  }
  return normalized;
}

export function resolveAssetConsentPolicy(
  config: Pick<
    AppConfig,
    | "nodeEnv"
    | "assetConsentVersion"
    | "assetDefaultTtlHours"
    | "assetConsentProcessor"
    | "assetConsentPurposeText"
    | "assetConsentRetentionText"
  >,
): AssetConsentPolicySnapshot {
  if (config.nodeEnv === "production"
    && (!config.assetConsentProcessor
      || !config.assetConsentPurposeText
      || !config.assetConsentRetentionText
      || config.assetConsentProcessor.startsWith("development-placeholder")
      || config.assetConsentPurposeText.startsWith("development-placeholder")
      || config.assetConsentRetentionText.startsWith("development-placeholder"))) {
    throw new Error("生产环境必须配置完整的 AI 素材同意政策快照");
  }
  const processor = assertPolicyText(
    "ASSET_CONSENT_PROCESSOR",
    config.assetConsentProcessor ?? DEVELOPMENT_PROCESSOR,
    500,
  );
  const processingPurpose = assertPolicyText(
    "ASSET_CONSENT_PURPOSE_TEXT",
    config.assetConsentPurposeText ?? DEVELOPMENT_PURPOSE,
    1_000,
  );
  const retention = assertPolicyText(
    "ASSET_CONSENT_RETENTION_TEXT",
    config.assetConsentRetentionText
      ?? `development-placeholder: AI 素材默认在 ${config.assetDefaultTtlHours} 小时后到期`,
    1_000,
  );
  const snapshot = {
    policySha256: calculateAssetConsentPolicySha256(config.assetConsentVersion, {
      processor,
      processingPurpose,
      retention,
    }),
    processor,
    processingPurpose,
    retention,
  };
  return snapshot;
}

export function calculateAssetConsentPolicySha256(
  consentVersion: string,
  policy: Omit<AssetConsentPolicySnapshot, "policySha256">,
): string {
  const canonicalPolicy = [
    consentVersion,
    policy.processor,
    policy.processingPurpose,
    policy.retention,
  ].join("\n");
  return createHash("sha256").update(canonicalPolicy, "utf8").digest("hex");
}

export function assertAssetConsentPolicySnapshot(
  consentVersion: string,
  policy: AssetConsentPolicySnapshot,
): void {
  const processor = assertPolicyText("processor", policy.processor, 500);
  const processingPurpose = assertPolicyText("processingPurpose", policy.processingPurpose, 1_000);
  const retention = assertPolicyText("retention", policy.retention, 1_000);
  if (processor !== policy.processor
    || processingPurpose !== policy.processingPurpose
    || retention !== policy.retention) {
    throw new AppError(400, "ASSET_CONSENT_POLICY_TEXT_INVALID", "AI 素材同意政策文本必须使用规范格式");
  }
  const expected = calculateAssetConsentPolicySha256(consentVersion, {
    processor,
    processingPurpose,
    retention,
  });
  if (policy.policySha256 !== expected) {
    throw new AppError(400, "ASSET_CONSENT_POLICY_HASH_INVALID", "AI 素材同意政策哈希无效");
  }
}
