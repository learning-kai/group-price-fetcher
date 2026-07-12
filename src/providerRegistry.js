import { newApiProvider } from "./providers/newApi.js";
import { sub2apiProvider } from "./providers/sub2api.js";
import { ulingGatewayProvider } from "./providers/ulingGateway.js";

const providers = new Map([
  [ulingGatewayProvider.id, ulingGatewayProvider],
  [sub2apiProvider.id, sub2apiProvider],
  [newApiProvider.id, newApiProvider]
]);

export function listProviders() {
  return [...providers.values()].map((provider) => ({
    id: provider.id,
    label: provider.label,
    description: provider.description,
    defaultBaseUrl: provider.defaultBaseUrl,
    supports: provider.supports
  }));
}

export function getProvider(providerId = ulingGatewayProvider.id) {
  const provider = providers.get(providerId);
  if (!provider) {
    throw new Error(`未知 provider：${providerId}`);
  }
  return provider;
}
