import type { WorklistKind } from '@consultorio/contracts';
import {
  BellOff,
  Hourglass,
  MailWarning,
  MessageSquareReply,
  PhoneCall,
  ReceiptText,
  UserRoundSearch,
  type LucideIcon,
} from 'lucide-react';

/** The kinds of item (scheduling, "Reception worklist"), each with an icon and a word. */
export const KIND_ICONS: Record<WorklistKind, LucideIcon> = {
  pending_approval: Hourglass,
  identity_review: UserRoundSearch,
  reminder_not_sent: BellOff,
  reminder_not_delivered: MailWarning,
  reply_to_review: MessageSquareReply,
  waitlist_manual_contact: PhoneCall,
  invoice_attention: ReceiptText,
};
