import { writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { fetchBatchPrices, parseTargetLines } from "./batch.js";
import { resolveEdgeToken } from "./edgeAuth.js";
import { getProvider } from "./providerRegistry.js";
import { toCsv, toJson } from "./exporters.js";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

try {
  const provider = getProvider(args.provider || "uling-gateway");
  const tokenEnv = args.tokenEnv || "ULING_TOKEN";
  const token = args.token || process.env[tokenEnv];

  if (!token && !args.targets && !args.edge) {
    throw new Error("缺少 Token。请设置环境变量 ULING_TOKEN，或使用 --token-env 指定变量名。");
  }

  const options = {
    token,
    mode: args.mode || "user",
    includeKeys: args.includeKeys === true,
    includeUserOverrides: args.includeUserOverrides === true,
    resolveToken: args.edge
      ? async (baseUrl) => resolveEdgeToken(baseUrl, {
        allowRefresh: args.edgeRefresh === true,
        openEdgeOnFailure: args.openEdge === true,
        edgeWaitMs: args.edgeWaitMs ? Number(args.edgeWaitMs) : undefined
      })
      : null
  };

  const result = args.targets
    ? await fetchBatchFromFile({ provider, path: args.targets, options })
    : await provider.fetchPrices({
      baseUrl: args.baseUrl || provider.defaultBaseUrl,
      ...options,
      token: token || (args.edge
        ? (await resolveEdgeToken(args.baseUrl || provider.defaultBaseUrl, {
          allowRefresh: args.edgeRefresh === true,
          openEdgeOnFailure: args.openEdge === true,
          edgeWaitMs: args.edgeWaitMs ? Number(args.edgeWaitMs) : undefined
        })).token
        : token)
    });

  const format = args.format || "json";
  const output = format === "csv" ? toCsv(result) : toJson(result);

  if (args.out) {
    await writeFile(args.out, output, "utf8");
    console.log(`已写入 ${args.out}`);
  } else {
    process.stdout.write(output);
    if (!output.endsWith("\n")) process.stdout.write("\n");
  }
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;

    const key = toCamel(arg.slice(2));
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }

  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printHelp() {
  console.log(`分组价格采集器 CLI

用法:
  npm run cli -- --base-url https://api-provider.uling19.com --format csv --out prices.csv
  npm run cli -- --targets sites.txt --format csv --out prices.csv

参数:
  --provider <id>             默认 uling-gateway
  --base-url <url>            目标站点根地址
  --targets <file>            批量站点文件，每行: 名称 | URL | TOKEN_ENV
  --edge                      从本机 Edge 登录态读取 Token
  --open-edge                 登录态失效时尝试打开 Edge 的 /keys 页面
  --edge-wait-ms <ms>         配合 --open-edge，等待 Edge 写回 token 的最长时间
  --edge-refresh              允许 CLI 使用 refresh_token 续期（会消耗轮换 token）
  --token-env <name>          读取 Token 的环境变量，默认 ULING_TOKEN
  --mode <user|admin>         接口模式，默认 user
  --format <json|csv>         输出格式，默认 json
  --out <file>                输出文件
  --include-keys              附带 key 与分组关系
  --include-user-overrides    管理员模式下附带用户单独倍率
`);
}

async function fetchBatchFromFile({ provider, path, options }) {
  const text = await readFile(path, "utf8");
  const targets = parseTargetLines(text, (tokenRef) => process.env[tokenRef] || tokenRef);

  if (!targets.length) {
    throw new Error("批量站点文件为空");
  }

  return fetchBatchPrices({ provider, targets, options });
}
