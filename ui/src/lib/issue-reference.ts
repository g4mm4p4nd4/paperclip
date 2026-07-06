type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

const BARE_ISSUE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]+-\d+$/i;
const ISSUE_REFERENCE_TOKEN_RE = /https?:\/\/[^\s<>()]+|\b[A-Z][A-Z0-9]+-\d+(?!\.\d)(?!-[A-Z0-9])\b/gi;

export interface IssueReferenceOptions {
  allowedPrefixes?: readonly string[] | null;
}

function normalizedAllowedPrefixes(options?: IssueReferenceOptions): Set<string> | null {
  const prefixes = options?.allowedPrefixes
    ?.map((prefix) => prefix.trim().toUpperCase())
    .filter(Boolean);
  return prefixes && prefixes.length > 0 ? new Set(prefixes) : null;
}

function prefixForIssuePathId(pathId: string): string | null {
  if (!BARE_ISSUE_IDENTIFIER_RE.test(pathId)) return null;
  return pathId.split("-", 1)[0]?.toUpperCase() ?? null;
}

function isAllowedIssuePathId(pathId: string, options?: IssueReferenceOptions): boolean {
  const allowedPrefixes = normalizedAllowedPrefixes(options);
  if (!allowedPrefixes) return true;
  const prefix = prefixForIssuePathId(pathId);
  return prefix === null || allowedPrefixes.has(prefix);
}

export function parseIssuePathIdFromPath(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  let pathname = pathOrUrl.trim();
  if (!pathname) return null;

  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return null;
    }
  }

  const segments = pathname.split("/").filter(Boolean);
  const issueIndex = segments.findIndex((segment) => segment === "issues");
  if (issueIndex === -1 || issueIndex === segments.length - 1) return null;
  return decodeURIComponent(segments[issueIndex + 1] ?? "");
}

export function parseIssueReferenceFromHref(href: string | null | undefined, options?: IssueReferenceOptions) {
  if (!href) return null;
  const pathId = parseIssuePathIdFromPath(href);
  if (pathId) {
    if (!isAllowedIssuePathId(pathId, options)) return null;
    return {
      issuePathId: pathId,
      href: `/issues/${encodeURIComponent(pathId)}`,
    };
  }

  const trimmed = href.trim();
  if (!BARE_ISSUE_IDENTIFIER_RE.test(trimmed)) return null;
  const normalized = trimmed.toUpperCase();
  if (!isAllowedIssuePathId(normalized, options)) return null;
  return {
    issuePathId: normalized,
    href: `/issues/${encodeURIComponent(normalized)}`,
  };
}

function splitTrailingPunctuation(token: string) {
  let core = token;
  let trailing = "";

  while (core.length > 0) {
    const lastChar = core.at(-1);
    if (!lastChar || !/[),.;!?]/.test(lastChar)) break;
    if (lastChar === ")") {
      const openCount = (core.match(/\(/g) ?? []).length;
      const closeCount = (core.match(/\)/g) ?? []).length;
      if (closeCount <= openCount) break;
    }
    trailing = `${lastChar}${trailing}`;
    core = core.slice(0, -1);
  }

  return { core, trailing };
}

function createIssueLinkNode(value: string, href: string, childType: "text" | "inlineCode" = "text"): MarkdownNode {
  return {
    type: "link",
    url: href,
    children: [{ type: childType, value }],
  };
}

function linkifyIssueReferencesInText(value: string, options?: IssueReferenceOptions): MarkdownNode[] | null {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  let matched = false;

  for (const match of value.matchAll(ISSUE_REFERENCE_TOKEN_RE)) {
    const raw = match[0];
    if (!raw) continue;

    const start = match.index ?? 0;
    const end = start + raw.length;
    const { core, trailing } = splitTrailingPunctuation(raw);
    const issueRef = parseIssueReferenceFromHref(core, options);
    if (!issueRef) continue;

    matched = true;
    if (start > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, start) });
    }
    nodes.push(createIssueLinkNode(core, issueRef.href));
    if (trailing) {
      nodes.push({ type: "text", value: trailing });
    }
    cursor = end;
  }

  if (!matched) return null;
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}

function rewriteMarkdownTree(node: MarkdownNode, options?: IssueReferenceOptions) {
  if (!Array.isArray(node.children) || node.children.length === 0) return;
  if (node.type === "link" || node.type === "linkReference" || node.type === "code" || node.type === "definition" || node.type === "html") {
    return;
  }

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const issueRef = parseIssueReferenceFromHref(child.value, options);
      if (issueRef) {
        nextChildren.push(createIssueLinkNode(child.value, issueRef.href, "inlineCode"));
        continue;
      }
    }

    if (child.type === "text" && typeof child.value === "string") {
      const linked = linkifyIssueReferencesInText(child.value, options);
      if (linked) {
        nextChildren.push(...linked);
        continue;
      }
    }

    rewriteMarkdownTree(child, options);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export function remarkLinkIssueReferences(options?: IssueReferenceOptions) {
  return (tree: MarkdownNode) => {
    rewriteMarkdownTree(tree, options);
  };
}
