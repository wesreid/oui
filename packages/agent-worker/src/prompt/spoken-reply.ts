/**
 * A reply that will be spoken is written for the ear.
 *
 * On a live call a voice reads the reply out, and the person sees none of its
 * text. Written as for a chat, it fails there: markdown is read out as symbols
 * or dropped, a list or a link is a run of words nobody can follow, a price
 * written "$28,500" may be said digit by digit, and a long answer holds the
 * person on the line. The turn's context says so (`context.output = { mode:
 * 'voice' }`), and the model is told to speak in short sentences and to show,
 * through the page's actions, anything the person needs to look at.
 *
 * - **What is read:** `readReplyOutput` from `@ouispec/agent-core` keeps only
 *   a known mode; anything else is a reply shown as text, which is given
 *   nothing.
 * - **Where it goes:** after the conversation, with what else is true only
 *   for this turn (step-messages.ts), as the line for a spoken message does
 *   (spoken-input.ts), never in the system prompt or on the message. The system
 *   prompt and the tools are a cached prefix, shared by the conversation's
 *   chat turns and its call turns: the rule there would make every switch
 *   between them write the prefix again, and on the message it would change a
 *   message the next turn sends without it.
 */
import { REPLY_OUTPUT_CONTEXT_KEY, readReplyOutput, type ReplyOutput, type VoiceDirections } from '@ouispec/agent-core';

/** How the turn's reply reaches the person, from the turn's context; null when it is shown as text. */
export function readClientReplyOutput(context: Record<string, unknown> | null | undefined): ReplyOutput | null {
  return readReplyOutput(context?.[REPLY_OUTPUT_CONTEXT_KEY]);
}

/** What the model is told about a reply that will be spoken. */
export function spokenReplyText(output: ReplyOutput): string {
  return (
    '<output>Your reply will be spoken aloud to the user on a live call; they will hear it, not read it. ' +
    'Speak in short, plain sentences, one idea at a time, and keep the reply brief. ' +
    'Use no markdown, lists, headings, links, code or emoji. ' +
    'Write numbers, prices, dates and times the way a person says them aloud, in words, and spell out symbols and abbreviations. ' +
    'Never read out a link, an id or a long list: show what the user should look at through the page’s actions, and say in a sentence what you are showing. ' +
    'Before something that takes a while to look up or do, first say in a few words what you are doing.' +
    (output.voiceDirections ? ` ${voiceDirectionsText(output.voiceDirections)}` : '') +
    '</output>'
  );
}

/**
 * What the model is told it may direct the voice with: the speaking service's
 * own tags and guidance (`output.voiceDirections`), after the rules above. A
 * tag is written into the reply where it applies, and the voice performs it.
 */
function voiceDirectionsText(directions: VoiceDirections): string {
  return (
    `The voice that reads your reply (${directions.engine}) can be directed with these inline tags, written exactly as shown, where they apply: ` +
    `${directions.tags.join(' ')}. They are not markdown: the voice performs them and does not read them out. ` +
    `Use no other tags. ${directions.guidance}`
  );
}
