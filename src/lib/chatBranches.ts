import type { MessageRecord, MessageWithBranchInfo } from '@/types';

/**
 * Given all messages in a chat and the active-branches map, compute the linear
 * sequence of messages on the currently-active path through the message tree.
 *
 * Walks from the root (parentMessageId === null, branchIndex === 0) forward,
 * at each step picking the child whose branchIndex matches activeBranches[currentId]
 * (defaulting to 0 when no entry exists).
 */
export function resolveActivePath(
  messages: MessageRecord[],
  activeBranches: Record<string, number> | null,
): MessageRecord[] {
  const branches = activeBranches ?? {};

  const roots = messages.filter(
    (m) => m.parentMessageId === null && m.branchIndex === 0,
  );
  if (roots.length === 0) return [];

  const path: MessageRecord[] = [roots[0]];
  let current = roots[0];

  while (true) {
    const children = messages.filter((m) => m.parentMessageId === current.id);
    if (children.length === 0) break;

    const targetBranchIndex = branches[current.id] ?? 0;
    const next =
      children.find((c) => c.branchIndex === targetBranchIndex) ??
      children.sort((a, b) => a.branchIndex - b.branchIndex)[0];

    path.push(next);
    current = next;
  }

  return path;
}

/**
 * Returns the count of siblings at a message's parent (including the message itself).
 */
export function getSiblingCount(
  messageId: string,
  messages: MessageRecord[],
): number {
  const target = messages.find((m) => m.id === messageId);
  if (!target) return 1;
  return messages.filter((m) => m.parentMessageId === target.parentMessageId).length;
}

/**
 * Returns the 1-indexed branch position for a message (branchIndex 0 → position 1).
 */
export function getBranchPosition(
  messageId: string,
  messages: MessageRecord[],
): number {
  const target = messages.find((m) => m.id === messageId);
  if (!target) return 1;
  return target.branchIndex + 1;
}

/**
 * Decorates a list of messages with branch info (branchCount, branchPosition)
 * for rendering. Operates on a flat list — typically the active path.
 */
export function decorateWithBranchInfo(
  activePath: MessageRecord[],
  allMessages: MessageRecord[],
): MessageWithBranchInfo[] {
  return activePath.map((m) => ({
    ...m,
    branchCount: allMessages.filter(
      (other) => other.parentMessageId === m.parentMessageId,
    ).length,
    branchPosition: m.branchIndex + 1,
  }));
}
