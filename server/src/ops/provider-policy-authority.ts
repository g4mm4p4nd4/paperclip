import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishActiveProviderPolicyAuthority } from "../services/provider-policy-authority.js";

export function parseProviderPolicyAuthorityPublishArgs(rawArgv: string[]) {
  const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  if (argv.length === 0) return { help: false };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { help: true };
  throw new Error("provider_policy_authority_publish_argument_invalid");
}

export async function publishProviderPolicyAuthorityCli(rawArgv = process.argv.slice(2)) {
  const args = parseProviderPolicyAuthorityPublishArgs(rawArgv);
  if (args.help) {
    console.log("Usage: pnpm ops:provider-policy-authority");
    return null;
  }
  const binding = await publishActiveProviderPolicyAuthority();
  const output = {
    schema_version: "paperclip.provider_policy_authority_publish.v1",
    provider_policy_authority: binding,
  };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishProviderPolicyAuthorityCli().catch((error) => {
    console.error(JSON.stringify({
      status: "failed",
      blocker: error instanceof Error ? error.message : "provider_policy_authority_publish_unknown_failure",
    }));
    process.exit(1);
  });
}
