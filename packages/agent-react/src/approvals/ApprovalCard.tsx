/**
 * ApprovalCard — where the user approves, or declines, the one irreversible
 * call a turn stopped at.
 *
 * It shows what the call does in the action's own declared words (its title,
 * what it does, its arguments by their labels), never the assistant's. A
 * click on Approve or Decline goes to the approval store on the user's own
 * socket, an approval's grant goes to this tab's OUI runtime (`grantApproval`
 * in the client config), and the turn continues with the token outside the
 * message text. A "yes" typed in the product's chat is only a message.
 *
 * On a call, or in a chat where the agent read the call back, the person may
 * also decide by saying so. The card then shows how they decided
 * ("Approved by voice") and its buttons go; the grant reaches this tab's
 * runtime from the store, and the conversation's own turn carries the token.
 *
 * The card takes no `agent` prop, and the package declares it person-only
 * (`oui.personOnly`), so the generator refuses to bind it: the assistant can
 * never operate its own approval. It renders its own buttons; a host draws it
 * with its design system's parts through `components`.
 */
import React, { useContext, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { ApprovalDecisionContext } from './decision.js';

/** The frame: a design system's card, with a title, a line under it, a body and actions. */
export interface ApprovalCardFrameProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Always `warning`: the call cannot be undone. */
  tone?: 'default' | 'warning' | 'error';
  actions?: ReactNode;
  children?: ReactNode;
}

/** A button: Approve is `primary`, Decline and Dismiss `secondary`. */
export interface ApprovalCardButtonProps {
  variant?: 'primary' | 'secondary';
  onClick?: () => unknown;
  disabled?: boolean;
  children?: ReactNode;
}

export interface ApprovalCardParts {
  Card: ComponentType<ApprovalCardFrameProps>;
  Button: ComponentType<ApprovalCardButtonProps>;
}

/** The conversation channels a person can decide an approval in, outside the card. */
export type ApprovalCardElsewhereChannel = 'voice' | 'phone' | 'chat' | 'sms';

export interface ApprovalCardLabels {
  approve: string;
  decline: string;
  dismiss: string;
  waiting: string;
  expired: string;
  /** What the card says once the person approved by voice, on the phone or in chat. */
  approvedBy: Record<Exclude<ApprovalCardElsewhereChannel, 'sms'>, string>;
  /** What the card says once the person declined in a conversation channel. */
  declinedBy: Record<ApprovalCardElsewhereChannel, string>;
}

export interface ApprovalCardProps {
  /** The host's own card and button. Default: plain, unstyled HTML. */
  components?: Partial<ApprovalCardParts>;
  /** The card's own words, for another language. `approvedBy` and `declinedBy` may name only some channels. */
  labels?: Partial<Omit<ApprovalCardLabels, 'approvedBy' | 'declinedBy'>> & {
    approvedBy?: Partial<ApprovalCardLabels['approvedBy']>;
    declinedBy?: Partial<ApprovalCardLabels['declinedBy']>;
  };
}

const DEFAULT_LABELS: ApprovalCardLabels = {
  approve: 'Approve',
  decline: 'Decline',
  dismiss: 'Dismiss',
  waiting: 'This runs only if you approve it here.',
  expired: 'This approval has expired.',
  approvedBy: { voice: 'Approved by voice.', phone: 'Approved on the phone.', chat: 'Approved in the chat.' },
  declinedBy: { voice: 'Declined by voice.', phone: 'Declined on the phone.', chat: 'Declined in the chat.', sms: 'Declined by text message.' },
};

function PlainCard({ title, subtitle, actions, children }: ApprovalCardFrameProps) {
  return (
    <section aria-label={typeof title === 'string' ? title : undefined}>
      <h3>{title}</h3>
      {subtitle ? <p>{subtitle}</p> : null}
      {children}
      <div>{actions}</div>
    </section>
  );
}

function PlainButton({ onClick, disabled, children }: ApprovalCardButtonProps) {
  return (
    <button type="button" disabled={disabled} onClick={() => void onClick?.()}>
      {children}
    </button>
  );
}

/** Renders nothing until a turn stops for the user's approval. */
export function ApprovalCard({ components, labels }: ApprovalCardProps) {
  const decision = useContext(ApprovalDecisionContext);
  if (!decision) throw new Error('ApprovalCard must be used within an AgentProvider');
  const { pending, decidedElsewhere, deciding, error, decide, dismiss } = decision;
  const expired = useExpired(pending?.expiresAt);
  if (!pending) return null;

  const Card = components?.Card ?? PlainCard;
  const Button = components?.Button ?? PlainButton;
  const text: ApprovalCardLabels = {
    ...DEFAULT_LABELS,
    ...labels,
    approvedBy: { ...DEFAULT_LABELS.approvedBy, ...labels?.approvedBy },
    declinedBy: { ...DEFAULT_LABELS.declinedBy, ...labels?.declinedBy },
  };
  const closed = expired || error !== null;
  const { preview } = pending;
  const argumentList =
    preview.arguments.length > 0 ? (
      <dl>
        {preview.arguments.map(arg => (
          <React.Fragment key={arg.name}>
            <dt>{arg.label}</dt>
            <dd>{arg.value}</dd>
          </React.Fragment>
        ))}
      </dl>
    ) : null;

  // Decided by voice, on the phone or in chat: the card says how, and no longer decides.
  if (decidedElsewhere) {
    const said = elsewhereText(text, decidedElsewhere.decision, decidedElsewhere.channel);
    return (
      <Card
        title={preview.title}
        subtitle={preview.consequence}
        tone={decidedElsewhere.decision === 'approve' ? 'default' : 'warning'}
        actions={
          <Button variant="secondary" onClick={dismiss}>
            {text.dismiss}
          </Button>
        }
      >
        {argumentList}
        <p role="status">{said}</p>
      </Card>
    );
  }

  return (
    <Card
      title={preview.title}
      subtitle={preview.consequence}
      tone="warning"
      actions={
        <>
          {closed ? (
            <Button variant="secondary" onClick={dismiss} disabled={deciding}>
              {error !== null ? text.dismiss : text.decline}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => decide('decline')} disabled={deciding}>
              {text.decline}
            </Button>
          )}
          <Button variant="primary" onClick={() => decide('approve')} disabled={deciding || closed}>
            {text.approve}
          </Button>
        </>
      }
    >
      {argumentList}
      {error !== null ? <p role="alert">{error}</p> : <p>{expired ? text.expired : text.waiting}</p>}
    </Card>
  );
}

/** What the card says of a decision made in a conversation channel. */
function elsewhereText(text: ApprovalCardLabels, decision: 'approve' | 'decline', channel: string): string {
  if (decision === 'approve') return text.approvedBy[channel as keyof ApprovalCardLabels['approvedBy']] ?? text.approvedBy.voice;
  return text.declinedBy[channel as ApprovalCardElsewhereChannel] ?? text.declinedBy.voice;
}

/** Whether `expiresAt` has passed, turning true when it does. */
function useExpired(expiresAt: number | undefined): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === undefined) return;
    setNow(Date.now());
    const left = expiresAt - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), left);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return expiresAt !== undefined && now >= expiresAt;
}
