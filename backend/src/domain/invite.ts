import { randomBytes } from "node:crypto";

import { AppError } from "../errors.js";
import type { InviteBinding, InviteRewardEntitlement, InviteSummary, UserInviteCode } from "./models.js";
import {
  INVITE_REWARD_INVITEE_CREDITS,
  INVITE_REWARD_INVITER_CREDITS_NEW_USER,
  INVITE_REWARD_INVITER_CREDITS_RETURNING_USER,
  INVITE_REWARD_LEDGER_REASON,
} from "./models.js";

const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateInviteCode(byteLength = 10): string {
  const bytes = randomBytes(byteLength);
  let code = "";
  for (const byte of bytes) {
    code += INVITE_CODE_ALPHABET[byte % INVITE_CODE_ALPHABET.length];
  }
  return code;
}

export function normalizeInviteCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{8,32}$/.test(code)) {
    throw new AppError(400, "INVALID_INVITE_CODE", "邀请码格式无效");
  }
  return code;
}

export function inviteRewardDeltaForInvitee(inviteeWasNewUser: boolean): 3 | 1 {
  return inviteeWasNewUser
    ? INVITE_REWARD_INVITER_CREDITS_NEW_USER
    : INVITE_REWARD_INVITER_CREDITS_RETURNING_USER;
}

export function buildInviteSummary(input: {
  invite: UserInviteCode;
  binding: InviteBinding | null;
  entitlements: InviteRewardEntitlement[];
}): InviteSummary {
  return {
    invite: input.invite,
    binding: input.binding,
    entitlements: input.entitlements,
    rewardPolicy: {
      creditAmountConfigured: true,
      shareProofRequired: false,
      ledgerReasonReserved: INVITE_REWARD_LEDGER_REASON,
      awardsCredits: true,
      inviterCreditAmountNewUser: INVITE_REWARD_INVITER_CREDITS_NEW_USER,
      inviterCreditAmountReturningUser: INVITE_REWARD_INVITER_CREDITS_RETURNING_USER,
      inviteeCreditAmount: INVITE_REWARD_INVITEE_CREDITS,
    },
  };
}

export function assertInviteAcceptAllowed(input: {
  inviteeUserId: string;
  inviterUserId: string;
  existing: InviteBinding | null;
  inviteCode: string;
}): "create" | "replay" {
  if (input.inviteeUserId === input.inviterUserId) {
    throw new AppError(409, "INVITE_SELF_NOT_ALLOWED", "不能使用自己的邀请码");
  }
  if (!input.existing) return "create";
  if (input.existing.inviterUserId === input.inviterUserId && input.existing.inviteCode === input.inviteCode) {
    return "replay";
  }
  throw new AppError(409, "INVITE_ALREADY_BOUND", "该账号已绑定过邀请关系，不能重复领取");
}
