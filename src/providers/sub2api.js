import {
  fetchPrices as fetchGatewayPrices,
  probeCompatibility as probeGatewayCompatibility
} from "./ulingGateway.js";

export const sub2apiProvider = {
  id: "sub2api",
  label: "sub2api",
  description: "支持账号密码登录和用户分组倍率的 sub2api 部署",
  defaultBaseUrl: "",
  supports: {
    userMode: true,
    passwordLogin: true,
    userOverrides: true
  },
  probeCompatibility,
  fetchPrices
};

export async function probeCompatibility(options, client) {
  const result = await probeGatewayCompatibility(options, client);
  return { ...result, providerId: sub2apiProvider.id };
}

export async function fetchPrices(options, client) {
  const result = await fetchGatewayPrices(options, client);
  return {
    ...result,
    providerId: sub2apiProvider.id,
    providerLabel: sub2apiProvider.label
  };
}
