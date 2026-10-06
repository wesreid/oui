/**
 * The attachment cost guard (ADR-0252 §2.11).
 *
 * A file given to the model is resent with every model step of the turn, so
 * what a turn costs is what it gives each step times the steps it takes.
 * Before each step the guard adds up what that step would carry; when the
 * turn's cap or the conversation's would be passed, the costliest files are
 * given as their reference line from that step on, and the model is told they
 * were left out. A file left out is still in the conversation and still
 * usable by actions.
 */
import { DEFAULT_CONVERSATION_ATTACHMENT_TOKENS, DEFAULT_TURN_ATTACHMENT_TOKENS } from './limits.js';

/** One thing a turn gives the model of a file, for as long as it is given. */
export interface GuardedPart {
  /** Unique within the turn. */
  key: string;
  attachmentId: string;
  kind: 'image' | 'text' | 'pdf';
  /** Estimated tokens each step it is given. */
  tokens: number;
  /** Characters of text, for the usage log. */
  textChars?: number;
  /** Pages of a PDF given as a document, for the usage log. */
  pdfPages?: number;
  /** Where it is: the turn's user message, or a tool call's result. */
  where: { message: true } | { toolCallId: string };
  /** What the model is given in its place once it is left out. */
  leftOutLine: string;
  /** The part itself, on the user message, so it can be found and replaced. */
  part?: unknown;
}

export interface AttachmentUsage {
  count: number;
  images: number;
  textChars: number;
  pdfPages: number;
  estimatedTokens: number;
  leftOut: number;
}

export class AttachmentGuard {
  private readonly turnCap: number;
  private readonly conversationCap: number;
  private readonly active = new Map<string, GuardedPart>();
  private readonly given = new Map<string, GuardedPart>();
  private readonly leftOut = new Set<string>();
  private spent = 0;

  constructor(options: { turnTokens?: number; conversationTokens?: number; conversationUsed?: number } = {}) {
    this.turnCap = options.turnTokens ?? DEFAULT_TURN_ATTACHMENT_TOKENS;
    // The conversation's cap, less what its earlier turns gave: what this turn may still give.
    this.conversationCap = Math.max(0, (options.conversationTokens ?? DEFAULT_CONVERSATION_ATTACHMENT_TOKENS) - (options.conversationUsed ?? 0));
  }

  private get cap(): number {
    return Math.min(this.turnCap, this.conversationCap);
  }

  private activeTokens(): number {
    let sum = 0;
    for (const part of this.active.values()) sum += part.tokens;
    return sum;
  }

  /** Whether a part of `tokens` fits in the next step as well as what is already given. */
  admits(tokens: number): boolean {
    return this.spent + this.activeTokens() + tokens <= this.cap;
  }

  /** Give a part from the next step on. */
  add(part: GuardedPart): void {
    this.active.set(part.key, part);
    this.given.set(part.key, part);
  }

  /** Record a part that was not given at all: over the cap before its first step. */
  refuse(part: Omit<GuardedPart, 'where' | 'leftOutLine'>): void {
    this.given.set(part.key, { ...part, where: { message: true }, leftOutLine: '' });
    this.leftOut.add(part.key);
  }

  /**
   * Before a step: leave out the costliest parts until the step fits, then
   * count the step. Returns the parts left out at this step.
   */
  beforeStep(): GuardedPart[] {
    const dropped: GuardedPart[] = [];
    while (this.active.size > 0 && this.spent + this.activeTokens() > this.cap) {
      const costliest = [...this.active.values()].reduce((a, b) => (b.tokens > a.tokens ? b : a));
      this.active.delete(costliest.key);
      this.leftOut.add(costliest.key);
      dropped.push(costliest);
    }
    this.spent += this.activeTokens();
    return dropped;
  }

  /** Every part left out so far, with what replaces it. */
  leftOutParts(): GuardedPart[] {
    return [...this.leftOut].map((key) => this.given.get(key)!).filter((p) => p.leftOutLine);
  }

  usage(): AttachmentUsage {
    const parts = [...this.given.values()];
    return {
      count: new Set(parts.map((p) => p.attachmentId)).size,
      images: parts.filter((p) => p.kind === 'image' && !this.leftOut.has(p.key)).length,
      textChars: parts.filter((p) => !this.leftOut.has(p.key)).reduce((sum, p) => sum + (p.textChars ?? 0), 0),
      pdfPages: parts.filter((p) => !this.leftOut.has(p.key)).reduce((sum, p) => sum + (p.pdfPages ?? 0), 0),
      estimatedTokens: this.spent,
      leftOut: this.leftOut.size,
    };
  }
}
