import type { AppConfig } from "../config.js";
import { ArkGenerationProvider } from "./ark-provider.js";
import { DeterministicGenerationProvider } from "./deterministic-provider.js";
import { HttpGenerationProvider } from "./http-provider.js";
import { ModeRoutingGenerationProvider } from "./mode-routing-provider.js";
import type { GenerationProvider } from "./provider.js";
import { RasterPaletteGenerationProvider } from "./raster-provider.js";

type GenerationProviderConfig = Pick<
  AppConfig,
  "nodeEnv" | "generationProviderUrl" | "generationProviderApiKey" | "generationProviderTimeoutMilliseconds" | "arkApiKey" | "arkImageModel" | "arkVisionModel"
>;

export function createConfiguredGenerationProvider(config: GenerationProviderConfig): GenerationProvider {
  const hasEndpoint = config.generationProviderUrl !== undefined;
  const hasApiKey = config.generationProviderApiKey !== undefined;
  const hasArkApiKey = config.arkApiKey !== undefined;
  const raster = new RasterPaletteGenerationProvider();
  if (!hasEndpoint && !hasApiKey && hasArkApiKey) {
    const ai = new ArkGenerationProvider({
      apiKey: config.arkApiKey!,
      ...(config.arkImageModel ? { imageModel: config.arkImageModel } : {}),
      ...(config.arkVisionModel ? { visionModel: config.arkVisionModel } : {}),
      ...(config.generationProviderTimeoutMilliseconds !== undefined
        ? { timeoutMilliseconds: config.generationProviderTimeoutMilliseconds }
        : {}),
    });
    return new ModeRoutingGenerationProvider({
      raster,
      ai,
      ...(config.nodeEnv === "production"
        ? {}
        : { missingRasterSourceFallback: new DeterministicGenerationProvider() }),
    });
  }
  if (!hasEndpoint && !hasApiKey) {
    if (config.nodeEnv === "production") {
      throw new Error("生产环境必须配置 Generation Provider 或 ARK_API_KEY");
    }
    const deterministic = new DeterministicGenerationProvider();
    return new ModeRoutingGenerationProvider({
      raster,
      ai: deterministic,
      // Legacy development fixtures may not have uploaded a source. Keep them
      // runnable, but only outside production and never when bytes are present.
      missingRasterSourceFallback: deterministic,
    });
  }
  if (!hasEndpoint || !hasApiKey || config.generationProviderTimeoutMilliseconds === undefined) {
    throw new Error("Generation Provider 配置不完整，必须同时提供 URL、API key 和超时");
  }
  if (config.generationProviderUrl !== undefined && config.generationProviderApiKey !== undefined) {
    if (config.nodeEnv === "production") {
      let endpoint: URL;
      try {
        endpoint = new URL(config.generationProviderUrl);
      } catch {
        throw new Error("GENERATION_PROVIDER_URL 必须是有效的 HTTPS URL");
      }
      if (endpoint.protocol !== "https:") throw new Error("生产环境 Generation Provider 必须使用 HTTPS");
    }
    const ai = new HttpGenerationProvider({
      endpoint: config.generationProviderUrl,
      apiKey: config.generationProviderApiKey,
      timeoutMilliseconds: config.generationProviderTimeoutMilliseconds,
    });
    return new ModeRoutingGenerationProvider({
      raster,
      ai,
      ...(config.nodeEnv === "production"
        ? {}
        : { missingRasterSourceFallback: new DeterministicGenerationProvider() }),
    });
  }
  throw new Error("Generation Provider 配置不完整");
}
