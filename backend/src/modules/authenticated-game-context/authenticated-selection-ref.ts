import { createHash } from 'node:crypto';

export type AuthenticatedSelectionKind = 'campaign' | 'character';

export function authenticatedSelectionRef(
  kind: AuthenticatedSelectionKind,
  userId: string,
  internalId: string,
): string {
  return `sel_${createHash('sha256')
    .update(`authenticated-${kind}-selection:v1`)
    .update('\0')
    .update(userId)
    .update('\0')
    .update(internalId)
    .digest('base64url')}`;
}
