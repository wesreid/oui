/**
 * ApprovalCard — where the user approves, or declines, the one irreversible
 * call a turn stopped at (ADR-0228 §2.2.3).
 *
 * It shows what the call does in the action's own declared words (its title,
 * what it does, its arguments by their labels), never the assistant's. A
 * click on Approve or Decline is the only decision there is: it goes to the
 * approval store on the user's own socket, an approval's grant goes to this
 * tab's OUI runtime (`grantApproval` in the client config), and the turn
 * continues with the token outside the message text. A "yes" typed in chat is
 * only a message.
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

export interface ApprovalCardLabels {
  approve: string;
  decline: string;
  dismiss: string;
  waiting: string;
  expired: string;
}

export interface ApprovalCardProps {
  /** The host's own card and button. Default: plain, unstyled HTML. */
  components?: Partial<ApprovalCardParts>;
  /** The card's own words, for another language. */
  labels?: Partial<ApprovalCardLabels>;
}

const DEFAULT_LABELS: ApprovalCardLabels = {
  approve: 'Approve',
  decline: 'Decline',
  dismiss: 'Dismiss',
  waiting: 'This runs only if you approve it here.',
  expired: 'This approval has expired.',
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
  const { pending, deciding, error, decide, dismiss } = decision;
  const expired = useExpired(pending?.expiresAt);
  if (!pending) return null;

  const Card = components?.Card ?? PlainCard;
  const Button = components?.Button ?? PlainButton;
  const text = { ...DEFAULT_LABELS, ...labels };
  const closed = expired || error !== null;
  const { preview } = pending;

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
      {preview.arguments.length > 0 ? (
        <dl>
          {preview.arguments.map(arg => (
            <React.Fragment key={arg.name}>
              <dt>{arg.label}</dt>
              <dd>{arg.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
      {error !== null ? <p role="alert">{error}</p> : <p>{expired ? text.expired : text.waiting}</p>}
    </Card>
  );
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
