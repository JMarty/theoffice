/**
 * Who is allowed to DM a given agent. Secure-by-default:
 *  - the owner is ALWAYS allowed
 *  - if the agent has an explicit allowFrom list, only those ids (+owner) pass
 *  - if there is NO list but an owner IS configured -> owner-only (deny others)
 *  - if there is NO list and NO owner configured yet -> open (initial setup only)
 *
 * This is the gate that lets Gergő reach only Ryan and your wife reach only
 * Dwight, while everyone else is locked out of your private agents — even though
 * they share one Slack workspace.
 */
export function isAllowedSender(
  sender: string,
  allowFrom: string[] | undefined,
  ownerId: string | undefined
): boolean {
  if (ownerId && sender === ownerId) return true;
  if (allowFrom && allowFrom.length > 0) return allowFrom.includes(sender);
  return ownerId ? false : true;
}
