import path from "node:path";

export function resolveAppPaths(env = process.env) {
  const localAppData = env.GROUP_PRICE_FETCHER_HOME || env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("缺少 LOCALAPPDATA，无法确定本地数据目录");
  }

  const pathImpl = /^[A-Za-z]:[\\/]/.test(localAppData) ? path.win32 : path;
  const rootDir = env.GROUP_PRICE_FETCHER_HOME
    ? localAppData
    : pathImpl.join(localAppData, "GroupPriceFetcher");
  const profileDir = pathImpl.join(rootDir, "profiles");
  const dataDir = pathImpl.join(rootDir, "data");

  return {
    rootDir,
    profileDir,
    dataDir,
    dbPath: pathImpl.join(dataDir, "prices.db"),
    credentialVaultPath: pathImpl.join(dataDir, "credentials.vault")
  };
}
