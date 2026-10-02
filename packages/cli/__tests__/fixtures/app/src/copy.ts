/** Guidance written once, as constants, and read by the fields and their bindings. */

const PORTRAIT = 'what a head-and-shoulders portrait shows';

export const STYLE_RULE = `A style names the character and describes only ${PORTRAIT}.`;

export const STYLE_EXAMPLE = { style: 'Maya, short black hair, a grey blazer' };

export const STYLE_GUIDANCE = STYLE_RULE + ' Good: "' + STYLE_EXAMPLE.style + '"';

export const STYLE_HINT = `Only ${PORTRAIT}; at most ${1000} characters`;

/** Built by a call: not known without running it. */
export const JOINED = ['face', 'hair'].join(' and ');

/** A template over a value built by a call: not known either. */
export const WITH_JOINED = `Only the ${JOINED}.`;

/** A schema as a generated API client declares it: types only, no values to read. */
declare const $Schema: { readonly properties: { readonly tone: { readonly description: 'One word for the tone.' } } };
export const TONE_HINT = $Schema.properties.tone.description;

/** A name whose type allows many values. */
declare const anyText: string;
export const OPEN_TEXT = anyText;

/** A duration built from constants: half an hour, in milliseconds. */
const MINUTE_MS = 60_000;
export const HALF_HOUR_MS = 30 * MINUTE_MS;

/** Arithmetic on something unknown stays unknown. */
export const OPEN_SUM = anyText.length * 2;
