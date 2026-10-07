import { AppError } from "../errors.js";
import { isLocalDevelopmentAuthAllowed, type AppConfig } from "../config.js";

const MAX_WECHAT_LOGIN_CODE_LENGTH = 128;
const DEVELOPMENT_WECHAT_OPEN_ID = "pindou-local-development-user-v1";

export interface WechatMiniProgramIdentity {
  openId: string;
  unionId: string | null;
}

export interface WechatMiniProgramAuthProvider {
  readonly kind: "wechat-code2session" | "development";
  exchangeCode(code: string): Promise<WechatMiniProgramIdentity>;
}

interface WechatCodeSessionResponse {
  openid?: unknown;
  unionid?: unknown;
  session_key?: unknown;
  errcode?: unknown;
  errmsg?: unknown;
}

export interface WechatMiniProgramAuthClientOptions {
  appId: string;
  appSecret: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMilliseconds?: number;
}

function requireCredential(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} 不能为空`);
  return normalized;
}

function validateLoginCode(code: string): void {
  const normalized = code.trim();
  if (!normalized || normalized.length > MAX_WECHAT_LOGIN_CODE_LENGTH) {
    throw new AppError(400, "WECHAT_CODE_INVALID", "微信登录凭证无效");
  }
}

/**
 * A single, stable local identity for HBuilderX/WeChat DevTools integration.
 * It deliberately does not derive any identifier from the caller-supplied code.
 */
export class DevelopmentWechatMiniProgramAuthProvider implements WechatMiniProgramAuthProvider {
  readonly kind = "development" as const;

  async exchangeCode(code: string): Promise<WechatMiniProgramIdentity> {
    validateLoginCode(code);
    return { openId: DEVELOPMENT_WECHAT_OPEN_ID, unionId: null };
  }
}

export class WechatMiniProgramAuthClient implements WechatMiniProgramAuthProvider {
  readonly kind = "wechat-code2session" as const;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMilliseconds: number;

  constructor(options: WechatMiniProgramAuthClientOptions) {
    this.appId = requireCredential("WECHAT_APP_ID", options.appId);
    this.appSecret = requireCredential("WECHAT_APP_SECRET", options.appSecret);
    this.endpoint = options.endpoint ?? "https://api.weixin.qq.com/sns/jscode2session";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 8_000;
    if (!Number.isSafeInteger(this.timeoutMilliseconds) || this.timeoutMilliseconds < 100 || this.timeoutMilliseconds > 30_000) {
      throw new Error("微信登录请求超时必须介于 100 和 30000 毫秒之间");
    }
  }

  async exchangeCode(code: string): Promise<WechatMiniProgramIdentity> {
    validateLoginCode(code);
    const normalizedCode = code.trim();
    const url = new URL(this.endpoint);
    url.searchParams.set("appid", this.appId);
    url.searchParams.set("secret", this.appSecret);
    url.searchParams.set("js_code", normalizedCode);
    url.searchParams.set("grant_type", "authorization_code");

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
    } catch (error) {
      throw new AppError(503, "WECHAT_AUTH_UNAVAILABLE", "微信登录服务暂时不可用", {
        cause: error instanceof Error ? error.name : "network-error",
      }, true);
    }

    let payload: WechatCodeSessionResponse;
    try {
      payload = await response.json() as WechatCodeSessionResponse;
    } catch {
      throw new AppError(502, "WECHAT_AUTH_INVALID_RESPONSE", "微信登录服务返回了无效响应", null, true);
    }
    if (!response.ok || typeof payload.errcode === "number" && payload.errcode !== 0) {
      const codeValue = typeof payload.errcode === "number" ? payload.errcode : response.status;
      const retryable = response.status >= 500 || codeValue === -1;
      throw new AppError(
        retryable ? 503 : 401,
        retryable ? "WECHAT_AUTH_UNAVAILABLE" : "WECHAT_CODE_REJECTED",
        retryable ? "微信登录服务暂时不可用" : "微信登录凭证已失效，请重试",
        { wechatErrorCode: codeValue },
        retryable,
      );
    }
    if (typeof payload.openid !== "string" || payload.openid.length < 1 || payload.openid.length > 128) {
      throw new AppError(502, "WECHAT_AUTH_INVALID_RESPONSE", "微信登录服务未返回有效用户标识", null, true);
    }
    if (typeof payload.session_key !== "string" || payload.session_key.length < 1) {
      throw new AppError(502, "WECHAT_AUTH_INVALID_RESPONSE", "微信登录服务未返回有效会话密钥", null, true);
    }
    return {
      openId: payload.openid,
      unionId: typeof payload.unionid === "string" && payload.unionid.length > 0 ? payload.unionid : null,
    };
  }
}

export function isDevelopmentWechatAuthAllowed(
  config: Pick<AppConfig, "nodeEnv" | "host" | "devAuthEnabled">,
): boolean {
  return isLocalDevelopmentAuthAllowed(config);
}

export function createConfiguredWechatAuthProvider(
  config: Pick<AppConfig, "nodeEnv" | "host" | "devAuthEnabled" | "wechatAppId" | "wechatAppSecret">,
): WechatMiniProgramAuthProvider | undefined {
  const appId = config.wechatAppId?.trim();
  const appSecret = config.wechatAppSecret?.trim();

  if (config.nodeEnv === "production" && config.devAuthEnabled) {
    throw new Error("生产环境禁止启用开发微信登录 Provider");
  }
  if (appId && appSecret) {
    return new WechatMiniProgramAuthClient({ appId, appSecret });
  }
  if (config.devAuthEnabled && !isDevelopmentWechatAuthAllowed(config)) {
    throw new Error("开发微信登录 Provider 仅允许绑定 loopback 地址");
  }
  if (isDevelopmentWechatAuthAllowed(config)) {
    return new DevelopmentWechatMiniProgramAuthProvider();
  }
  if (appId || appSecret) {
    throw new Error("微信小程序登录配置不完整，且未显式启用本地开发登录");
  }
  return undefined;
}
